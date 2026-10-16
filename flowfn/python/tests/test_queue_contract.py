import asyncio
import pytest
from flowfn import create_flow
from flowfn.queue.types import JobOptions, JobStatus


@pytest.mark.asyncio
async def test_atomic_identity_and_payload_deduplication():
    flow = create_flow()
    queue = flow.queue("dedup")
    results = await asyncio.gather(
        *(queue.add("same", {"a": 1}, JobOptions(prevent_duplicates=True)) for _ in range(20))
    )
    assert len({job.id for job in results}) == 1
    assert len(await flow._adapter.get_all_jobs("dedup")) == 1
    distinct = await queue.add("different", {"a": 1}, JobOptions(prevent_duplicates=True))
    assert distinct.id != results[0].id
    identified = await queue.add("id", {}, JobOptions(job_id="stable"))
    assert await queue.add("id", {"ignored": True}, JobOptions(job_id="stable")) is identified
    await flow.close()


@pytest.mark.asyncio
async def test_dependencies_override_priority_and_failure_propagates():
    flow = create_flow()
    queue = flow.queue("dependencies")
    parent = await queue.add("parent", {}, JobOptions(priority=99, attempts=1))
    child = await queue.add("child", {}, JobOptions(priority=0, wait_for=[parent.id]))
    grandchild = await queue.add("grandchild", {}, JobOptions(wait_for=[child.id]))
    assert await flow._adapter.dequeue(queue.name) is parent

    async def fail(job):
        raise ValueError("expected")

    await queue._process_job(parent, fail)
    assert await flow._adapter.dequeue(queue.name) is None
    assert child.state == grandchild.state == JobStatus.FAILED
    await flow.close()


@pytest.mark.asyncio
async def test_dependency_success_and_cycle_rejection():
    flow = create_flow()
    queue = flow.queue("graph")
    child = await queue.add("child", {}, JobOptions(job_id="child", wait_for=["parent"]))
    with pytest.raises(ValueError, match="cycle"):
        await queue.add("bad", {}, JobOptions(job_id="parent", wait_for=["child"]))
    parent = await queue.add("parent", {}, JobOptions(job_id="parent"))
    assert await flow._adapter.dequeue(queue.name) is parent

    async def succeed(job):
        return "ok"

    await queue._process_job(parent, succeed)
    assert await flow._adapter.dequeue(queue.name) is child
    await flow.close()


@pytest.mark.asyncio
async def test_default_job_options_merge_explicit_values():
    flow = create_flow(default_job_options={"attempts": 7, "priority": 9})
    queue = flow.queue("defaults")
    first = await queue.add("default", {})
    override = await queue.add("override", {}, JobOptions(attempts=1))
    assert first.opts.attempts == 7
    assert override.opts.attempts == 1
    assert override.opts.priority == 9
    await flow.close()
