"""Storage-time relative scheduling without changing explicit absolute schedules."""

from __future__ import annotations

import asyncio
import time

import pytest

from flowfn.queue.queue import Queue
from flowfn.queue.types import BackoffOptions, BackoffType, Job, JobOptions, JobStatus
from tests.native_support import NativeAdapters


@pytest.mark.parametrize('skew', [-3_600_000, 3_600_000])
@pytest.mark.parametrize('dependencies', [False, True])
async def test_queue_clock_relative_creation_retry_and_claim(adapters: NativeAdapters, skew: int, dependencies: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    a, b = adapters
    a.reclaim_after_ms = b.reclaim_after_ms = 10000
    queue = Queue('clock', a)
    def now() -> int:
        return int(time.time() * 1000)
    monkeypatch.setattr(queue, "_now", lambda: now() + skew)
    if dependencies:
        await a.enqueue('clock', Job(id='parent', name='parent', data={}, timestamp=now()))
        parent = await b.dequeue('clock')
        assert parent is not None
        parent.state = JobStatus.COMPLETED
        await b.update_job('clock', parent)
    retry_delay = 2000  # Leave room for native roundtrips before the early-dequeue checks.
    start = now()
    created = await queue.add('job', {'arrays': [[], {}]}, JobOptions(
        delay=200, attempts=2, backoff=BackoffOptions(type=BackoffType.FIXED, delay=retry_delay),
        wait_for=['parent'] if dependencies else None,
    ))
    assert start - 100 <= created.timestamp <= now() + 100
    assert created.available_at is not None
    assert start + 100 <= created.available_at <= now() + 300
    assert await b.dequeue('clock') is None
    await asyncio.sleep(.26)
    claimed = await b.dequeue('clock')
    assert claimed is not None
    assert claimed.id == created.id
    assert claimed.processed_on is not None
    assert start <= claimed.processed_on <= now() + 100
    worker = Queue('clock', b)
    monkeypatch.setattr(worker, "_now", lambda: now() - skew)
    async def fail(_job: Job) -> None:
        raise RuntimeError('retry fixture')
    retry_start = now()
    native_before = int((await b.health_probe())['server_time'])
    await worker._process_job(claimed, fail)
    native_after = int((await b.health_probe())['server_time'])
    retried = next(job for job in await a.get_all_jobs('clock') if job.id == created.id)
    assert retried.processed_on == claimed.processed_on
    assert retried.delay == 200  # Retry uses retry_delay, not the original delay.
    assert retried.available_at is not None
    assert native_before + retry_delay <= retried.available_at <= native_after + retry_delay
    assert '_relative_delay_ms' not in retried.model_dump()
    assert await a.dequeue('clock') is None
    await asyncio.sleep(.23)
    early = await a.dequeue('clock')
    native_checked = int((await a.health_probe())['server_time'])
    assert early is None, (retried.available_at, native_checked, early)
    assert native_checked < retried.available_at, (retried.available_at, native_checked)
    await asyncio.sleep(max(0, retried.available_at - native_checked) / 1000 + .05)
    final = await a.dequeue('clock')
    assert final is not None
    assert final.id == created.id
    assert final.processed_on is not None
    assert final.processed_on >= retried.available_at
    assert final.processed_on >= retry_start
    final.state = JobStatus.COMPLETED
    await a.update_job('clock', final)


async def test_queue_clock_preserves_explicit_absolute_schedule(adapters: NativeAdapters) -> None:
    a, b = adapters
    now = int(time.time() * 1000)
    job = Job(id='absolute', name='absolute', data={}, timestamp=now-3_600_000,
              available_at=now+2000, delay=5000, state=JobStatus.DELAYED)
    result = await a.enqueue('absolute', job)
    assert result.available_at == job.available_at
    assert result.timestamp == job.timestamp
    early = await b.dequeue('absolute')
    native_checked = int((await b.health_probe())['server_time'])
    assert early is None, (job.available_at, native_checked, early)
    assert job.available_at is not None
    assert native_checked < job.available_at, (job.available_at, native_checked)
    await asyncio.sleep(max(0, job.available_at - native_checked) / 1000 + .05)
    claimed = await b.dequeue('absolute')
    assert claimed is not None
    assert claimed.id == job.id
    assert claimed.processed_on is not None
    assert claimed.processed_on >= job.available_at
    claimed.state = JobStatus.COMPLETED
    await b.update_job('absolute', claimed)


async def test_queue_clock_metrics_do_not_subtract_server_time_from_worker_time(adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch) -> None:
    from flowfn.core.metrics import MetricsManager
    a, b = adapters
    metrics = MetricsManager(b)
    producer = Queue('duration', a)
    await producer.add('job', {})
    claimed = await b.dequeue('duration')
    assert claimed is not None
    server_start = claimed.processed_on
    worker = Queue('duration', b, metrics=metrics)
    clock = [int(time.time()*1000) + 3_600_000]
    monkeypatch.setattr(worker, "_now", lambda: clock[0])
    async def complete(_job: Job) -> None:
        clock[0] += 25
    await worker._process_job(claimed, complete)
    stored = (await a.get_all_jobs('duration'))[0]
    assert stored.processed_on == server_start
    assert (await metrics.get_queue_metrics('duration'))['avg_duration'] == 25
