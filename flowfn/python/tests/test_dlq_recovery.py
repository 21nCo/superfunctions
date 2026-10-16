import asyncio
import pytest
from flowfn import create_flow
from flowfn.queue.types import JobOptions, JobStatus


@pytest.mark.asyncio
async def test_failed_job_retries_through_real_queue_preserving_options():
    flow = create_flow()
    queue = flow.queue("emails")
    fail = [True]

    async def handler(job):
        if fail[0]:
            raise ValueError("delivery failed")
        return "sent"

    queue.process(handler)
    job = await queue.add(
        "send", {"to": "fixture"}, JobOptions(attempts=1, priority=8, job_id="same")
    )
    await asyncio.wait_for(queue.drain(), 2)
    letters = await flow.dlq().get_all()
    assert len(letters) == 1
    assert letters[0].original_queue == "emails"
    letters[0].data["to"] = "mutated"
    fail[0] = False
    retried = await flow.dlq().retry(job.id)
    assert retried.opts.priority == 8
    assert retried.data["to"] == "fixture"
    await asyncio.wait_for(queue.drain(), 2)
    assert retried.state == JobStatus.COMPLETED
    assert retried.returnvalue == "sent"
    assert await flow.dlq().get_all() == []
    await flow.close()


@pytest.mark.asyncio
async def test_same_id_different_queues_require_explicit_scope():
    flow = create_flow()

    async def fail(job):
        raise ValueError("expected")

    for name in ["one", "two"]:
        queue = flow.queue(name)
        job = await queue.add("task", {}, JobOptions(attempts=1, job_id="same"))
        await flow._adapter.dequeue(name)
        await queue._process_job(job, fail)
    with pytest.raises(ValueError, match="ambiguous"):
        await flow.dlq().retry("same")
    assert await flow.dlq().retry_all("one") == 1
    assert len(await flow.dlq().get_all()) == 1
    assert (await flow.dlq().get_stats()).by_queue == {"two": 1}
    assert await flow.dlq().clean(0) == 1
    await flow.close()


@pytest.mark.asyncio
async def test_failed_requeue_retains_dead_letter(monkeypatch):
    flow = create_flow()
    queue = flow.queue("persist")
    job = await queue.add("task", {}, JobOptions(attempts=1))

    async def fail(job):
        raise ValueError("expected")

    await flow._adapter.dequeue(queue.name)
    await queue._process_job(job, fail)

    async def unavailable(*args):
        raise RuntimeError("storage unavailable")

    monkeypatch.setattr(flow._adapter, "retry_dead_letter", unavailable)
    with pytest.raises(RuntimeError, match="unavailable"):
        await flow.dlq().retry(job.id)
    assert len(await flow.dlq().get_all()) == 1
    await flow.close()
