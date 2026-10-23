"""Local lifecycle notifications follow committed storage transitions."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from flowfn import create_flow
from flowfn.adapters.base import FlowAdapter
from flowfn.adapters.memory import MemoryAdapter
from flowfn.adapters.postgres import PostgresAdapter
from flowfn.queue.types import Job, JobOptions
from flowfn.workflow.types import WorkflowContext
from tests.assertions import require_value
from tests.native_support import NativeAdapters


async def check_events(adapter: FlowAdapter) -> None:
    if hasattr(adapter, "reclaim_after_ms"):
        adapter.reclaim_after_ms = 5000
    errors = []
    flow = create_flow(adapter, on_error=lambda error, context: errors.append(context["operation"]))
    created: list[dict[str, Any]] = []
    completed = []
    flow.on("job:created", lambda event: created.append(event))
    unsubscribe = flow.on("job:completed", lambda event: completed.append(event))

    async def broken(event: dict[str, Any]) -> None:
        event["job_id"] = "modified"
        raise ValueError("listener failed")

    flow.on("job:completed", broken)
    queue = flow.queue("events")
    try:
        jobs = await asyncio.gather(
            *(queue.add("same", {}, JobOptions(job_id="same")) for _ in range(8))
        )
        assert len(created) == 1
        assert created[0]["job_id"] == "same"
        assert "enqueue_created" not in jobs[0].model_dump()

        async def handler(job: Job) -> str:
            return "done"

        job = await flow._adapter.dequeue(queue.name)
        assert job is not None
        await queue._process_job(job, handler)
        assert completed[0]["job_id"] == "same"
        assert (require_value(await queue.get_job("same"))).state.value == "completed"
        assert errors == ["flowfn.event.job:completed"]
        unsubscribe()
        await queue.add("second", {})
        job = await flow._adapter.dequeue(queue.name)
        assert job is not None
        await queue._process_job(job, handler)
        assert len(completed) == 1
        stream = flow.stream("events")
        await stream.publish({"secret": "never-track"})

        async def step(context: WorkflowContext) -> None:
            return None

        workflow = flow.workflow("events").step("step", step).build()
        execution = await workflow.execute({"secret": "never-track"})
        await asyncio.wait_for(workflow._tasks[execution.id], 10)
        events = flow.get_event_tracker().get_events()
        assert {
            "job:created",
            "job:active",
            "job:completed",
            "stream:message",
            "workflow:started",
            "workflow:completed",
        } <= {event.type for event in events}
        assert "never-track" not in str(events)
        require_value(events[0].metadata)["job_id"] = "changed"
        assert require_value(flow.get_event_tracker().get_events()[0].metadata)["job_id"] == "same"
        assert flow.get_event_tracker().get_events({"limit": 0}) == []
    finally:
        await flow.close()


async def test_memory_events() -> None:
    await check_events(MemoryAdapter())


async def test_native_events(adapters: NativeAdapters) -> None:
    await check_events(adapters[0])


async def check_receipts(a: FlowAdapter, b: FlowAdapter) -> None:
    left, right = create_flow(a), create_flow(b)
    created: list[dict[str, Any]] = []
    left.on("job:created", created.append)
    right.on("job:created", created.append)
    try:
        jobs = await asyncio.gather(
            *(
                flow.queue("dedup").add("same", {}, JobOptions(prevent_duplicates=True))
                for flow in [left, right] * 4
            )
        )
        assert len({job.id for job in jobs}) == 1
        assert len(created) == 1
        # Dependency-bearing enqueue uses the projected transaction path.
        child = await left.queue("dedup").add(
            "child", {}, JobOptions(job_id="child", wait_for=[jobs[0].id])
        )
        duplicate = await right.queue("dedup").add(
            "child", {}, JobOptions(job_id="child", wait_for=[jobs[0].id])
        )
        assert child.id == duplicate.id
        assert len(created) == 2
    finally:
        await left.close()
        await right.close()


async def test_native_atomic_receipts(adapters: NativeAdapters) -> None:
    await check_receipts(*adapters)


async def test_failed_write_does_not_emit_created(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = MemoryAdapter()
    flow = create_flow(adapter)
    events: list[dict[str, Any]] = []
    flow.on("job:created", events.append)

    async def fail(*args: Any) -> None:
        raise RuntimeError("write failed")

    monkeypatch.setattr(adapter, "enqueue", fail)
    with pytest.raises(RuntimeError):
        await flow.queue("failed").add("one", {})
    assert events == []
    await flow.close()


async def test_terminal_failures_and_fenced_completion_events(monkeypatch: pytest.MonkeyPatch) -> None:
    from flowfn.queue.types import JobLeaseError

    flow = create_flow()
    queue = flow.queue("failures")

    async def fail(value: Job) -> None:
        raise ValueError("expected failure")

    await queue.add("failed", {}, JobOptions(attempts=1))
    job = await flow._adapter.dequeue(queue.name)
    assert job is not None
    await queue._process_job(job, fail)
    workflow = flow.workflow("failure").step("fail", fail).build()
    execution = await workflow.execute({})
    await asyncio.wait_for(workflow._tasks[execution.id], 5)
    await queue.add("fenced", {})
    job = await flow._adapter.dequeue(queue.name)
    assert job is not None

    async def reject(*args: Any) -> None:
        raise JobLeaseError("ownership lost")

    monkeypatch.setattr(flow._adapter, "update_job", reject)

    async def success(value: Job) -> int:
        return 1

    with pytest.raises(JobLeaseError):
        await queue._process_job(job, success)
    kinds = [event.type for event in flow.get_event_tracker().get_events()]
    assert "job:failed" in kinds
    assert "workflow:failed" in kinds
    assert "job:stalled" in kinds
    assert "job:completed" not in kinds
    await flow.close()


async def test_postgres_old_enqueue_reply_stays_compatible(adapters: NativeAdapters) -> None:
    import json

    from flowfn.queue.types import Job

    adapter, _ = adapters
    if not isinstance(adapter, PostgresAdapter):
        pytest.skip("PostgreSQL function version compatibility")
    await adapter.enqueue("compat", Job(id="new", name="new", data={}, timestamp=0))
    pool = await adapter._database()
    job = Job(id="old-client", name="old", data={}, timestamp=0)
    raw = await pool.fetchval(
        "SELECT flowfn_py_enqueue_v2($1,$2,$3,$4)",
        adapter.namespace,
        "compat",
        json.dumps([adapter.namespace, "compat"]),
        job.model_dump_json(),
    )
    result = json.loads(raw)
    assert result["id"] == "old-client"
    assert "job" not in result


async def test_canceled_stall_listener_never_persists_lost_job(monkeypatch: pytest.MonkeyPatch) -> None:
    from flowfn.queue.types import JobLeaseError
    flow = create_flow()
    queue = flow.queue('lost')
    await queue.add('one', {})
    job = await flow._adapter.dequeue(queue.name)
    assert job is not None
    writes = []
    async def record(*args: Any) -> None:
        writes.append(args)
    monkeypatch.setattr(flow._adapter, 'update_job', record)
    async def listener(event: dict[str, Any]) -> None:
        raise asyncio.CancelledError()
    flow.on('job:stalled', listener)
    async def lost(job: Job) -> None:
        raise JobLeaseError('lost')
    with pytest.raises(asyncio.CancelledError):
        await queue._process_job(job, lost)
    assert writes == []
    await flow.close()
