"""Cooperative cancellation against actual durable ownership changes."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable, cast

import pytest

from flowfn.adapters.redis import RedisAdapter
from flowfn.queue.queue import Queue
from flowfn.queue.types import Job, JobStatus
from tests.assertions import require_value
from tests.native_support import NativeAdapters


@pytest.mark.parametrize('failure', ['takeover', 'hung_renewal'])
async def test_lost_lease_cancels_handler_without_retry_or_stale_write(adapters: NativeAdapters, failure: str, monkeypatch: pytest.MonkeyPatch) -> None:
    a, b = adapters
    queue = Queue('cancel', a)
    job = await queue.add('hold', {})
    entered, stopped = asyncio.Event(), asyncio.Event()
    effects = []
    original = a._transition

    async def transition(method: str, *args: Any) -> Any:
        if method == '_renew_job' and failure == 'hung_renewal':
            await asyncio.Event().wait()
        return await original(method, *args)

    monkeypatch.setattr(a, "_transition", transition)

    async def handler(claim: Job) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
            effects.append('stale side effect')
        finally:
            stopped.set()

    queue.process(handler)
    try:
        await asyncio.wait_for(entered.wait(), 3)
        if failure == 'takeover':
            if isinstance(a, RedisAdapter):
                from redis.exceptions import WatchError
                base = a.prefix+':queue:cancel'
                while True:
                    async with a.client.pipeline(transaction=True) as pipe:
                        try:
                            await pipe.watch(base+':version')
                            raw_state = await pipe.execute_command('HGET',base+':jobs',job.id)
                            assert isinstance(raw_state, (str, bytes))
                            state = json.loads(raw_state)
                            state['lease_expires_at'] = 0
                            # redis-py exposes this synchronous transaction marker without annotations.
                            cast(Callable[[], None], pipe.multi)()
                            pipe.hset(base+':jobs',job.id,json.dumps(state))
                            pipe.zadd(base+':leases',{job.id:0})
                            pipe.incr(base+':version')
                            await pipe.execute()
                            break
                        except WatchError:
                            continue
            else:
                pool = await a._database()
                await pool.execute("""UPDATE flowfn_py_jobs SET lease=0,payload=jsonb_set(
                    payload,'{lease_expires_at}','0') WHERE namespace=$1 AND queue='cancel'""", a.namespace)
        else:
            await asyncio.wait_for(stopped.wait(), 3)
        # Stop the old worker polling before the new owner is acquired.
        queue._processing = False
        claim = None
        for _ in range(100):
            claim = await b.dequeue('cancel')
            if claim is not None:
                break
            await asyncio.sleep(.02)
        assert claim is not None
        await asyncio.wait_for(stopped.wait(), 3)
        await asyncio.gather(*queue._workers)
        claim.state = JobStatus.COMPLETED
        claim.returnvalue = 'new owner'
        await b.update_job('cancel', claim)
        stored = (await b.get_all_jobs('cancel'))[0]
        assert stored.id == job.id
        assert stored.returnvalue == 'new owner'
        assert stored.attempts_made == 0
        assert stored.failed_reason is None
        assert await b.get_dead_letters() == []
        assert effects == []
        assert not a._job_heartbeats
        assert not a._job_events
    finally:
        await queue.close()


async def test_claim_reply_after_local_lease_deadline_never_starts_handler(adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch) -> None:
    from flowfn.queue.types import JobLeaseError
    a,b=adapters
    a.reclaim_after_ms=200
    b.reclaim_after_ms=30000
    queue=Queue('late-claim',a)
    await queue.add('job',{})
    original=a._transition
    async def delayed_reply(method: str,*args: Any) -> Any:
        result=await original(method,*args)
        if method=='dequeue':
            await asyncio.sleep(.25)
        return result
    monkeypatch.setattr(a, "_transition", delayed_reply)
    claim=await a.dequeue(queue.name)
    assert claim is not None
    assert require_value(a.lease_loss_event(queue.name,claim)).is_set()
    effects=[]
    async def handler(job: Job) -> None:
        effects.append(job.id)
    with pytest.raises(JobLeaseError):
        await queue._process_job(claim,handler)
    assert effects==[]
    replacement=await b.dequeue(queue.name)
    assert replacement is not None
    assert replacement.id==claim.id
    replacement.state=JobStatus.COMPLETED
    await b.update_job(queue.name,replacement)


async def test_delayed_native_replies_renew_from_request_start(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, b = adapters
    assert a.reclaim_after_ms == b.reclaim_after_ms == 1000
    original = a._transition
    renewals = 0
    origin = time.monotonic()
    timings: list[tuple[str, str, float]] = []

    async def delayed(method: str, *args: Any) -> Any:
        nonlocal renewals
        timings.append((method, 'request', (time.monotonic() - origin) * 1000))
        try:
            result = await original(method, *args)
            timings.append((method, 'storage_reply', (time.monotonic() - origin) * 1000))
            if method in ('dequeue', '_renew_job'):
                # Real storage transitions; delay only delivery of their replies.
                await asyncio.sleep(.45)
                if method == '_renew_job':
                    renewals += 1
            timings.append((method, 'delivered', (time.monotonic() - origin) * 1000))
            return result
        except BaseException as error:
            timings.append((method, type(error).__name__, (time.monotonic() - origin) * 1000))
            raise

    monkeypatch.setattr(a, '_transition', delayed)
    await a.enqueue('reply-delay', Job(id='held', name='held', data={}, timestamp=0))
    claimed = await a.dequeue('reply-delay')
    assert claimed is not None
    lost = a.lease_loss_event('reply-delay', claimed)
    assert lost is not None
    await asyncio.sleep(1.6)
    assert not lost.is_set(), json.dumps(timings)
    assert renewals >= 2, json.dumps(timings)
    assert await b.dequeue('reply-delay') is None
    claimed.state = JobStatus.COMPLETED
    await a.update_job('reply-delay', claimed)
    assert (await b.get_all_jobs('reply-delay'))[0].state == JobStatus.COMPLETED
