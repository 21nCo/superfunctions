"""Real Redis integration tests: set FLOWFN_REDIS_URL to a disposable service."""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest

from flowfn.queue.dlq import DLQManager
from flowfn.queue.types import Job, JobOptions, JobStatus
from flowfn.stream.types import ConsumerOptions, Message, TrimStrategy
from tests.assertions import require_value
from tests.native_support import NativeAdapters, PostgresFixtureAdapter, RedisFixtureAdapter


@pytest.fixture(params=['redis', 'postgres'])
async def adapters(request: pytest.FixtureRequest) -> AsyncIterator[NativeAdapters]:
    backend = request.param
    url = os.getenv('FLOWFN_' + backend.upper() + '_URL')
    if not url:
        pytest.skip('Requires disposable ' + backend)
    if backend == 'redis':
        pytest.importorskip('redis')
        adapter_type: type[RedisFixtureAdapter] | type[PostgresFixtureAdapter] = RedisFixtureAdapter
    else:
        pytest.importorskip('asyncpg')
        adapter_type = PostgresFixtureAdapter
    namespace = 'test-' + uuid.uuid4().hex
    a = adapter_type(url, namespace=namespace, reclaim_after_ms=1000)
    b = adapter_type(url, namespace=namespace, reclaim_after_ms=1000)
    a.test_url = b.test_url = url
    try:
        yield a, b
    finally:
        await a.cleanup()
        await b.cleanup()
        client = adapter_type(url, namespace=namespace)
        if isinstance(client, RedisFixtureAdapter):
            keys = [key async for key in client.client.scan_iter(match=client.prefix + ':*')]
            if keys:
                await client.client.delete(*keys)
        else:
            pool = await client._database()
            async with pool.acquire() as connection, connection.transaction():
                for table in ('job_edges','job_outcomes','dead_letters','jobs','queue_layout','pending','groups','events','workflows','state'):
                    if not await connection.fetchval("SELECT to_regclass($1)",'flowfn_py_'+table):
                        continue
                    await connection.execute('DELETE FROM flowfn_py_' + table + ' WHERE namespace=$1',namespace)
        await client.cleanup()


async def test_atomic_dedup_claim_and_dlq_retry(adapters: NativeAdapters) -> None:
    a, b = adapters
    jobs = [Job(id=str(i), name='send', data={}, timestamp=0,
                opts=JobOptions(prevent_duplicates=True)) for i in range(12)]
    results = await asyncio.gather(*(adapter.enqueue('q', job)
                                    for adapter, job in zip([a,b]*6, jobs)))
    assert len({job.id for job in results}) == 1
    claims = await asyncio.gather(a.dequeue('q'), b.dequeue('q'))
    assert sum(job is not None for job in claims) == 1
    job = next(job for job in claims if job is not None)
    job.state = JobStatus.FAILED
    await a.update_job('q', job)
    assert len(await b.get_dead_letters()) == 1
    await DLQManager(adapter=a).move_to_dlq(job, 'failed', 'q')
    attempts = await asyncio.gather(a.retry_dead_letter('q', job.id),
                                    b.retry_dead_letter('q', job.id), return_exceptions=True)
    assert sum(isinstance(item, Job) for item in attempts) == 1
    assert await b.get_dead_letters() == []
    assert (require_value(await b.get_queue_stats('q'))).waiting == 1


async def test_groups_cross_instance_heartbeat_trim_and_recovery(adapters: NativeAdapters) -> None:
    a, b = adapters
    started = asyncio.Event()
    deliveries = []

    async def hold(message: Message) -> None:
        deliveries.append(message.id)
        started.set()
        await asyncio.Event().wait()

    options = ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=1)
    sub = await a.consume('events','g','first',hold,options)
    message = Message(id='message', stream='events', data={'x':1}, timestamp=0)
    await b.publish('events',message)
    await asyncio.wait_for(started.wait(),2)
    received = asyncio.Event()

    async def accept(message: Message) -> None:
        deliveries.append(message.id)
        await message.ack()
        received.set()

    await b.consume('events','g','second',accept,options)
    await asyncio.sleep(2.5)
    assert deliveries == ['message']  # heartbeat protects slow live worker
    # Preserve one payload for this recovery test; Redis enforces zero caps
    # independently of active ownership (covered by native retention cases).
    keep = 1 if isinstance(b, RedisFixtureAdapter) else 0
    assert await b.trim_stream('events',TrimStrategy(max_length=keep)) == 0
    await sub.unsubscribe()
    await asyncio.wait_for(received.wait(),4)
    await asyncio.sleep(.05)
    assert deliveries == ['message','message']
    assert await b.trim_stream('events',TrimStrategy(max_length=0)) == 1
    assert await b.get_stream_messages('events') == []


async def test_durable_snapshot_new_connection_and_namespaces(adapters: NativeAdapters) -> None:
    a, b = adapters
    from flowfn.workflow.types import ExecutionStatus, WorkflowExecution
    job = Job(id='parent', name='parent', data={'nested':[1]}, timestamp=0)
    await a.enqueue('q',job)
    job.data['nested'].append(2)
    child = Job(id='child', name='child', data={}, timestamp=0,
                opts=JobOptions(wait_for=['parent']))
    await b.enqueue('q',child)
    parent = await b.dequeue('q')
    assert parent is not None
    assert parent.id == 'parent' and parent.data == {'nested':[1]}
    assert await a.dequeue('q') is None
    parent.state = JobStatus.COMPLETED
    await a.update_job('q', parent)
    assert (require_value(await b.dequeue('q'))).id == 'child'
    execution = WorkflowExecution(id='exec', workflow_id='workflow', input={},
                                  status=ExecutionStatus.RUNNING, started_at=1,created_at=1,updated_at=1)
    await a.save_workflow_state('exec',execution)
    await a.cleanup()
    restored = type(a)(a.test_url, namespace=a.namespace)
    isolated = type(a)(a.test_url, namespace='isolated-' + uuid.uuid4().hex)
    try:
        assert (require_value(await restored.load_workflow_state('exec'))).id == 'exec'
        from flowfn.workflow.workflow import Workflow
        listed = await Workflow('workflow', restored, []).list_executions()
        assert [item.id for item in listed] == ['exec']
        assert await Workflow('other', restored, []).list_executions() == []
        with pytest.raises(ValueError, match='Execution not found'):
            await Workflow('other', restored, []).get_execution('exec')
        assert len(await restored.get_all_jobs('q')) == 2
        assert await isolated.get_all_jobs('q') == []
    finally:
        await restored.cleanup()
        await isolated.cleanup()


async def test_job_lease_recovery_fences_old_completion(adapters: NativeAdapters) -> None:
    a, b = adapters
    await a.enqueue('jobs', Job(id='lease', name='work',data={},timestamp=0))
    old = await a.dequeue('jobs')
    assert old is not None
    await asyncio.sleep(2.5)
    assert await b.dequeue('jobs') is None
    await a.cleanup()
    await asyncio.sleep(1.2)
    current = await b.dequeue('jobs')
    assert current is not None
    assert current.id == old.id and current.lease_token != old.lease_token
    old.state = JobStatus.COMPLETED
    with pytest.raises(ValueError, match='ownership changed'):
        await b.update_job('jobs', old)
    current.state = JobStatus.COMPLETED
    await b.update_job('jobs',current)
    assert (require_value(await b.get_queue_stats('jobs'))).completed == 1


async def test_custom_backoff_restored_before_claim(adapters: NativeAdapters) -> None:
    from flowfn.queue.types import BackoffOptions, BackoffType
    a,b = adapters
    def strategy(attempt: int) -> int:
        return attempt * 7
    a.backoff_strategies['custom'] = strategy
    job = Job(id='custom', name='custom', data={}, timestamp=0,
              opts=JobOptions(backoff=BackoffOptions(type=BackoffType.CUSTOM,strategy=strategy)))
    await a.enqueue('q',job)
    with pytest.raises(ValueError,match='backoff_strategies'):
        await b.dequeue('q')
    assert (require_value(await a.get_queue_stats('q'))).waiting == 1
    b.backoff_strategies['custom'] = strategy
    claimed = await b.dequeue('q')
    assert claimed is not None
    assert require_value(require_value(claimed.opts.backoff).strategy)(3) == 21


async def test_concurrent_publication_preserves_every_group_delivery(adapters: NativeAdapters) -> None:
    a,b = adapters
    seen = set()
    done = asyncio.Event()

    async def handle(message: Message) -> None:
        seen.add(message.id)
        await message.ack()
        if len(seen) == 30:
            done.set()

    await a.consume('parallel','all','consumer',handle,
                    ConsumerOptions(group_id='all',from_beginning=True,max_in_flight=3))
    await asyncio.gather(*(adapter.publish('parallel',Message(id=str(i),stream='parallel',data=i,timestamp=0))
                           for i,adapter in enumerate([a,b]*15)))
    await asyncio.wait_for(done.wait(),10)
    assert seen == {str(i) for i in range(30)}


async def test_job_heartbeat_retries_transient_transport_failure(adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch) -> None:
    a,b=adapters
    original=a._transition
    failed=False
    renewals=0
    async def flaky(method: str,*args: Any) -> Any:
        nonlocal failed,renewals
        if method=='_renew_job':
            if not failed:
                failed=True
                raise ConnectionError('transient transport failure')
            renewals+=1
        return await original(method,*args)
    monkeypatch.setattr(a, "_transition", flaky)
    await a.enqueue('retry-heartbeat',Job(id='heartbeat',name='work',data={},timestamp=0))
    claimed=await a.dequeue('retry-heartbeat')
    assert claimed is not None
    await asyncio.sleep(2.2)
    assert failed and renewals>=2
    assert await b.dequeue('retry-heartbeat') is None
    claimed.state=JobStatus.COMPLETED
    await a.update_job('retry-heartbeat',claimed)
