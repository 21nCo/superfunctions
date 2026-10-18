"""Real Redis integration tests: set FLOWFN_REDIS_URL to a disposable service."""
import asyncio
import os
import uuid

import pytest

pytest.importorskip("redis")

from flowfn.adapters.redis import RedisAdapter
from flowfn.queue.types import Job, JobOptions, JobStatus
from flowfn.queue.dlq import DLQManager
from flowfn.stream.types import Message, ConsumerOptions, TrimStrategy

URL = os.getenv('FLOWFN_REDIS_URL')
pytestmark = pytest.mark.skipif(not URL, reason='Requires disposable Redis')


@pytest.fixture
async def adapters():
    namespace = 'test-' + uuid.uuid4().hex
    a = RedisAdapter(URL, namespace=namespace, reclaim_after_ms=150)
    b = RedisAdapter(URL, namespace=namespace, reclaim_after_ms=150)
    try:
        yield a, b
    finally:
        await a.cleanup()
        await b.cleanup()
        client = RedisAdapter(URL, namespace=namespace)
        keys = [key async for key in client.client.scan_iter(match=client.prefix + ':*')]
        if keys:
            await client.client.delete(*keys)
        await client.cleanup()


async def test_atomic_dedup_claim_and_dlq_retry(adapters):
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
    await DLQManager(adapter=a).move_to_dlq(job, 'failed', 'q')
    attempts = await asyncio.gather(a.retry_dead_letter('q', job.id),
                                    b.retry_dead_letter('q', job.id), return_exceptions=True)
    assert sum(isinstance(item, Job) for item in attempts) == 1
    assert await b.get_dead_letters() == []
    assert (await b.get_queue_stats('q')).waiting == 1


async def test_groups_cross_instance_heartbeat_trim_and_recovery(adapters):
    a, b = adapters
    started = asyncio.Event()
    deliveries = []

    async def hold(message):
        deliveries.append(message.id)
        started.set()
        await asyncio.Event().wait()

    options = ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=1)
    sub = await a.consume('events','g','first',hold,options)
    message = Message(id='message', stream='events', data={'x':1}, timestamp=0)
    await b.publish('events',message)
    await asyncio.wait_for(started.wait(),2)
    received = asyncio.Event()

    async def accept(message):
        deliveries.append(message.id)
        await message.ack()
        received.set()

    await b.consume('events','g','second',accept,options)
    await asyncio.sleep(.45)
    assert deliveries == ['message']  # heartbeat protects slow live worker
    assert await b.trim_stream('events',TrimStrategy(max_length=0)) == 0
    await sub.unsubscribe()
    await asyncio.wait_for(received.wait(),2)
    await asyncio.sleep(.05)
    assert deliveries == ['message','message']
    assert await b.trim_stream('events',TrimStrategy(max_length=0)) == 1
    assert await b.get_stream_messages('events') == []


async def test_durable_snapshot_new_connection_and_namespaces(adapters):
    a, b = adapters
    from flowfn.workflow.types import WorkflowExecution, ExecutionStatus
    job = Job(id='parent', name='parent', data={'nested':[1]}, timestamp=0)
    await a.enqueue('q',job)
    job.data['nested'].append(2)
    child = Job(id='child', name='child', data={}, timestamp=0,
                opts=JobOptions(wait_for=['parent']))
    await b.enqueue('q',child)
    parent = await b.dequeue('q')
    assert parent.id == 'parent' and parent.data == {'nested':[1]}
    assert await a.dequeue('q') is None
    parent.state = JobStatus.COMPLETED
    await a.update_job('q', parent)
    assert (await b.dequeue('q')).id == 'child'
    execution = WorkflowExecution(id='exec', workflow_id='workflow', input={},
                                  status=ExecutionStatus.RUNNING, started_at=1,created_at=1,updated_at=1)
    await a.save_workflow_state('exec',execution)
    await a.cleanup()
    restored = RedisAdapter(URL, namespace=a.prefix.removeprefix('flowfn:'))
    isolated = RedisAdapter(URL, namespace='isolated-' + uuid.uuid4().hex)
    try:
        assert (await restored.load_workflow_state('exec')).id == 'exec'
        assert len(await restored.get_all_jobs('q')) == 2
        assert await isolated.get_all_jobs('q') == []
    finally:
        await restored.cleanup()
        await isolated.cleanup()


async def test_job_lease_recovery_fences_old_completion(adapters):
    a, b = adapters
    await a.enqueue('jobs', Job(id='lease', name='work',data={},timestamp=0))
    old = await a.dequeue('jobs')
    await asyncio.sleep(.4)
    assert await b.dequeue('jobs') is None
    await a.cleanup()
    await asyncio.sleep(.2)
    current = await b.dequeue('jobs')
    assert current.id == old.id and current.lease_token != old.lease_token
    old.state = JobStatus.COMPLETED
    with pytest.raises(ValueError, match='ownership changed'):
        await b.update_job('jobs', old)
    current.state = JobStatus.COMPLETED
    await b.update_job('jobs',current)
    assert (await b.get_queue_stats('jobs')).completed == 1
