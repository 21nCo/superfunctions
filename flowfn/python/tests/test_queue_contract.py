from __future__ import annotations

import asyncio

import pytest

from flowfn import create_flow
from flowfn.adapters.memory import MemoryAdapter
from flowfn.queue.types import Job, JobOptions, JobStatus


@pytest.mark.asyncio
async def test_atomic_identity_and_payload_deduplication() -> None:
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
async def test_dependencies_override_priority_and_failure_propagates() -> None:
    flow = create_flow()
    queue = flow.queue("dependencies")
    parent = await queue.add("parent", {}, JobOptions(priority=99, attempts=1))
    child = await queue.add("child", {}, JobOptions(priority=0, wait_for=[parent.id]))
    grandchild = await queue.add("grandchild", {}, JobOptions(wait_for=[child.id]))
    assert await flow._adapter.dequeue(queue.name) is parent

    async def fail(job: Job) -> None:
        raise ValueError("expected")

    await queue._process_job(parent, fail)
    assert await flow._adapter.dequeue(queue.name) is None
    assert child.state == grandchild.state == JobStatus.FAILED
    assert {record.id for record in await flow.dlq().get_all()} == {
        parent.id,
        child.id,
        grandchild.id,
    }
    await flow.close()


@pytest.mark.asyncio
async def test_dependency_success_and_cycle_rejection() -> None:
    flow = create_flow()
    queue = flow.queue("graph")
    child = await queue.add("child", {}, JobOptions(job_id="child", wait_for=["parent"]))
    with pytest.raises(ValueError, match="cycle"):
        await queue.add("bad", {}, JobOptions(job_id="parent", wait_for=["child"]))
    parent = await queue.add("parent", {}, JobOptions(job_id="parent"))
    assert await flow._adapter.dequeue(queue.name) is parent

    async def succeed(job: Job) -> str:
        return "ok"

    await queue._process_job(parent, succeed)
    assert await flow._adapter.dequeue(queue.name) is child
    await flow.close()


@pytest.mark.asyncio
async def test_default_job_options_merge_explicit_values() -> None:
    flow = create_flow(default_job_options={"attempts": 7, "priority": 9})
    queue = flow.queue("defaults")
    first = await queue.add("default", {})
    override = await queue.add("override", {}, JobOptions(attempts=1))
    assert first.opts.attempts == 7
    assert override.opts.attempts == 1
    assert override.opts.priority == 9
    await flow.close()


@pytest.mark.asyncio
async def test_removal_retains_only_needed_dependency_outcomes() -> None:
    flow = create_flow()
    queue = flow.queue("retention")
    parent = await queue.add("parent", {}, JobOptions(remove_on_complete=True))
    child = await queue.add("child", {}, JobOptions(wait_for=[parent.id], remove_on_complete=True))

    async def succeed(job: Job) -> str:
        return "ok"

    assert await flow._adapter.dequeue(queue.name) is parent
    await queue._process_job(parent, succeed)
    assert await queue.get_job(parent.id) is None
    assert await flow._adapter.dequeue(queue.name) is child
    await queue._process_job(child, succeed)
    assert await queue.get_job(child.id) is None
    assert isinstance(flow._adapter, MemoryAdapter)
    assert flow._adapter._dependency_results == {}
    await flow.close()


@pytest.mark.asyncio
async def test_terminal_retention_count_and_failed_dead_letter_survives_removal() -> None:
    flow = create_flow()
    queue = flow.queue("bounded")

    async def succeed(job: Job) -> None:
        return None

    retained_ids = []
    for _i in range(4):
        job = await queue.add("success", {}, JobOptions(remove_on_complete=2))
        await flow._adapter.dequeue(queue.name)
        await queue._process_job(job, succeed)
        retained_ids.append(job.id)
    assert [job.id for job in await queue.get_jobs(JobStatus.COMPLETED)] == retained_ids[-2:]
    failed = await queue.add("failure", {}, JobOptions(attempts=1, remove_on_fail=True))

    async def fail(job: Job) -> None:
        raise ValueError("expected")

    await flow._adapter.dequeue(queue.name)
    await queue._process_job(failed, fail)
    assert await queue.get_job(failed.id) is None
    assert (await flow.dlq().get_all())[0].id == failed.id
    retried = await flow.dlq().retry(failed.id)
    assert await queue.get_job(failed.id) is retried
    await flow.close()
