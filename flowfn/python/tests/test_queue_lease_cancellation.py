"""Cooperative cancellation against actual durable ownership changes."""
import asyncio
import json

import pytest

from flowfn.queue.queue import Queue
from flowfn.queue.types import JobStatus
from tests.test_durable_adapters import adapters  # noqa: F401


@pytest.mark.parametrize('failure', ['takeover', 'hung_renewal'])
async def test_lost_lease_cancels_handler_without_retry_or_stale_write(adapters, failure):
    a, b = adapters
    queue = Queue('cancel', a)
    job = await queue.add('hold', {})
    entered, stopped = asyncio.Event(), asyncio.Event()
    effects = []
    original = a._transition

    async def transition(method, *args):
        if method == '_renew_job' and failure == 'hung_renewal':
            await asyncio.Event().wait()
        return await original(method, *args)

    a._transition = transition

    async def handler(claim):
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
            if hasattr(a, 'client'):
                from redis.exceptions import WatchError
                base = a.prefix+':queue:cancel'
                while True:
                    async with a.client.pipeline(transaction=True) as pipe:
                        try:
                            await pipe.watch(base+':version')
                            state = json.loads(await pipe.hget(base+':jobs',job.id))
                            state['lease_expires_at'] = 0
                            pipe.multi()
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


async def test_claim_reply_after_local_lease_deadline_never_starts_handler(adapters):
    from flowfn.queue.types import JobLeaseError
    a,b=adapters
    a.reclaim_after_ms=200
    b.reclaim_after_ms=30000
    queue=Queue('late-claim',a)
    await queue.add('job',{})
    original=a._transition
    async def delayed_reply(method,*args):
        result=await original(method,*args)
        if method=='dequeue':
            await asyncio.sleep(.25)
        return result
    a._transition=delayed_reply
    claim=await a.dequeue(queue.name)
    assert a.lease_loss_event(queue.name,claim).is_set()
    effects=[]
    async def handler(job):
        effects.append(job.id)
    with pytest.raises(JobLeaseError):
        await queue._process_job(claim,handler)
    assert effects==[]
    replacement=await b.dequeue(queue.name)
    assert replacement.id==claim.id
    replacement.state=JobStatus.COMPLETED
    await b.update_job(queue.name,replacement)
