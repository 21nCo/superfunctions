"""Storage-time relative scheduling without changing explicit absolute schedules."""
import asyncio
import time

import pytest

from flowfn.queue.queue import Queue
from flowfn.queue.types import Job, JobOptions, JobStatus, BackoffOptions, BackoffType
from tests.test_durable_adapters import adapters  # noqa: F401


@pytest.mark.parametrize('skew', [-3_600_000, 3_600_000])
@pytest.mark.parametrize('dependencies', [False, True])
async def test_queue_clock_relative_creation_retry_and_claim(adapters, skew, dependencies):
    a, b = adapters
    a.reclaim_after_ms = b.reclaim_after_ms = 10000
    queue = Queue('clock', a)
    now = lambda: int(time.time() * 1000)
    queue._now = lambda: now() + skew
    if dependencies:
        await a.enqueue('clock', Job(id='parent', name='parent', data={}, timestamp=now()))
        parent = await b.dequeue('clock')
        parent.state = JobStatus.COMPLETED
        await b.update_job('clock', parent)
    start = now()
    created = await queue.add('job', {'arrays': [[], {}]}, JobOptions(
        delay=200, attempts=2, backoff=BackoffOptions(type=BackoffType.FIXED, delay=350),
        wait_for=['parent'] if dependencies else None,
    ))
    assert start - 100 <= created.timestamp <= now() + 100
    assert start + 100 <= created.available_at <= now() + 300
    assert await b.dequeue('clock') is None
    await asyncio.sleep(.26)
    claimed = await b.dequeue('clock')
    assert claimed.id == created.id
    assert start <= claimed.processed_on <= now() + 100
    worker = Queue('clock', b)
    worker._now = lambda: now() - skew
    async def fail(_job):
        raise RuntimeError('retry fixture')
    retry_start = now()
    await worker._process_job(claimed, fail)
    retried = next(job for job in await a.get_all_jobs('clock') if job.id == created.id)
    assert retried.processed_on == claimed.processed_on
    assert retried.delay == 200  # The retry uses 350ms, not this original delay.
    assert retry_start + 250 <= retried.available_at <= now() + 450
    assert '_relative_delay_ms' not in retried.model_dump()
    assert await a.dequeue('clock') is None
    await asyncio.sleep(.23)
    assert await a.dequeue('clock') is None
    await asyncio.sleep(.18)
    final = await a.dequeue('clock')
    assert final.id == created.id
    assert final.processed_on >= retry_start
    final.state = JobStatus.COMPLETED
    await a.update_job('clock', final)


async def test_queue_clock_preserves_explicit_absolute_schedule(adapters):
    a, b = adapters
    now = int(time.time() * 1000)
    job = Job(id='absolute', name='absolute', data={}, timestamp=now-3_600_000,
              available_at=now+250, delay=5000, state=JobStatus.DELAYED)
    result = await a.enqueue('absolute', job)
    assert result.available_at == job.available_at
    assert result.timestamp == job.timestamp
    assert await b.dequeue('absolute') is None
    await asyncio.sleep(.31)
    claimed = await b.dequeue('absolute')
    assert claimed.id == job.id
    claimed.state = JobStatus.COMPLETED
    await b.update_job('absolute', claimed)


async def test_queue_clock_metrics_do_not_subtract_server_time_from_worker_time(adapters):
    from flowfn.core.metrics import MetricsManager
    a, b = adapters
    metrics = MetricsManager(b)
    producer = Queue('duration', a)
    await producer.add('job', {})
    claimed = await b.dequeue('duration')
    server_start = claimed.processed_on
    worker = Queue('duration', b, metrics=metrics)
    clock = [int(time.time()*1000) + 3_600_000]
    worker._now = lambda: clock[0]
    async def complete(_job):
        clock[0] += 25
    await worker._process_job(claimed, complete)
    stored = (await a.get_all_jobs('duration'))[0]
    assert stored.processed_on == server_start
    assert (await metrics.get_queue_metrics('duration'))['avg_duration'] == 25
