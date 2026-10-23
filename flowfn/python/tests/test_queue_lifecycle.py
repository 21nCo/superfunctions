import asyncio

import pytest

from flowfn import create_flow
from flowfn.queue.types import BackoffOptions, BackoffType, JobOptions, JobStatus


@pytest.mark.asyncio
async def test_delay_and_exponential_backoff_are_due_time_gated(monkeypatch):
    flow = create_flow()
    queue = flow.queue("retries")
    now = [1000]
    monkeypatch.setattr(queue, "_now", lambda: now[0])
    monkeypatch.setattr(flow._adapter, "_now", lambda: now[0])
    job = await queue.add(
        "job",
        {},
        JobOptions(delay=50, attempts=4, backoff=BackoffOptions(delay=100, max_delay=150)),
    )
    assert await flow._adapter.dequeue(queue.name) is None
    now[0] = 1050

    async def fail(job):
        raise ValueError("retry")

    assert await flow._adapter.dequeue(queue.name) is job
    await queue._process_job(job, fail)
    assert job.available_at == 1150
    assert job.state == JobStatus.DELAYED
    assert await flow._adapter.dequeue(queue.name) is None
    now[0] = 1150
    assert await flow._adapter.dequeue(queue.name) is job
    await queue._process_job(job, fail)
    assert job.available_at == 1300
    now[0] = 1300
    assert await flow._adapter.dequeue(queue.name) is job
    await queue._process_job(job, fail)
    now[0] = 1450
    assert await flow._adapter.dequeue(queue.name) is job
    await queue._process_job(job, fail)
    assert job.state == JobStatus.FAILED
    assert job.attempts_made == 4
    await flow.close()


@pytest.mark.asyncio
async def test_pause_resume_retains_workers_and_drain_waits_delayed():
    flow = create_flow()
    queue = flow.queue("pause")
    done = asyncio.Event()

    async def process(job):
        done.set()

    queue.process(process)
    await queue.pause()
    job = await queue.add("job", {}, JobOptions(delay=30))
    drain = asyncio.create_task(queue.drain())
    await asyncio.sleep(0.05)
    assert not done.is_set()
    assert not drain.done()
    await queue.resume()
    await asyncio.wait_for(drain, 2)
    assert done.is_set()
    assert job.state == JobStatus.COMPLETED
    await flow.close()


@pytest.mark.asyncio
async def test_timeout_cancels_handler_and_persists_failure():
    flow = create_flow()
    queue = flow.queue("timeout")
    stopped = asyncio.Event()
    job = await queue.add("job", {}, JobOptions(timeout=10, attempts=1))

    async def process(job):
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    queue.process(process)
    await asyncio.wait_for(queue.drain(), 2)
    assert stopped.is_set()
    assert (await queue.get_job(job.id)).state == JobStatus.FAILED
    await flow.close()


@pytest.mark.asyncio
async def test_close_requeues_cancelled_inflight_job():
    flow = create_flow()
    queue = flow.queue("cancel")
    entered = asyncio.Event()

    async def process(job):
        entered.set()
        await asyncio.Event().wait()

    job = await queue.add("job", {})
    queue.process(process)
    await asyncio.wait_for(entered.wait(), 2)
    await queue.close()
    assert job.state == JobStatus.WAITING
    assert job.attempts_made == 0
    with pytest.raises(RuntimeError, match="closed"):
        await queue.add("late", {})
    await flow.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "strategy, expected",
    [
        (lambda attempt: attempt * 25, JobStatus.DELAYED),
        (lambda attempt: float("nan"), JobStatus.FAILED),
    ],
)
async def test_custom_backoff_is_applied_or_fails_terminally(strategy, expected):
    flow = create_flow()
    queue = flow.queue("custom")
    job = await queue.add(
        "job", {}, JobOptions(backoff=BackoffOptions(type=BackoffType.CUSTOM, strategy=strategy))
    )
    await flow._adapter.dequeue(queue.name)

    async def fail(job):
        raise ValueError("retry")

    await queue._process_job(job, fail)
    assert job.state == expected
    assert not flow._adapter._active_jobs
    await flow.close()
