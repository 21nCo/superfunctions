"""Health status follows storage evidence instead of unconditional uptime."""

from __future__ import annotations

import asyncio

import pytest

from flowfn import create_flow
from flowfn.adapters.base import FlowAdapter
from flowfn.adapters.memory import MemoryAdapter
from flowfn.workflow.types import ExecutionStatus, WorkflowExecution
from tests.native_support import NativeAdapters


async def check_health(adapter: FlowAdapter) -> None:
    flow = create_flow(adapter)
    try:
        queue = flow.queue("ready")
        await queue.add("one", {})
        stream = flow.stream("events")
        await stream.publish("one")
        flow.workflow("abandoned").build()
        await adapter.save_workflow_state(
            "old",
            WorkflowExecution(
                id="old",
                workflow_id="abandoned",
                input={},
                status=ExecutionStatus.RUNNING,
                started_at=0,
                created_at=0,
                updated_at=0,
                lease_expires_at=1,
            ),
        )
        result = await flow.health_check()
        assert result["adapter"]["connected"]
        assert result["adapter"]["latency"] >= 0
        assert not result["healthy"]
        assert result["queues"][0]["waiting"] == 1
        assert result["queues"][0]["workers"] == 0
        assert result["streams"][0]["length"] == 1
        assert result["workflows"][0]["stalled"] == 1
        assert result["workflows"][0]["running"] == 1
    finally:
        await flow.close()
    assert not (await flow.health_check())["healthy"]


async def test_memory_health() -> None:
    await check_health(MemoryAdapter())


async def test_native_health(adapters: NativeAdapters) -> None:
    await check_health(adapters[0])


async def test_disconnected_storage_is_unhealthy_without_registered_resources(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = MemoryAdapter()
    flow = create_flow(adapter)

    async def fail() -> None:
        raise ConnectionError("storage unavailable")

    monkeypatch.setattr(adapter, "health_probe", fail)
    result = await flow.health_check()
    assert not result["healthy"]
    assert not result["adapter"]["connected"]
    assert any(check.get("message") == "storage unavailable" for check in result["checks"])
    await flow.close()


async def test_hung_probe_times_out_and_cancels_work(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = MemoryAdapter()
    flow = create_flow(adapter)
    canceled = asyncio.Event()

    async def hung() -> None:
        try:
            await asyncio.Event().wait()
        finally:
            canceled.set()

    monkeypatch.setattr(adapter, "health_probe", hung)
    result = await flow.health_check(timeout=0.02)
    assert not result["healthy"]
    assert canceled.is_set()
    assert result["checks"][-1]["name"] == "timeout"
    await flow.close()


async def test_resource_failure_and_missing_memory_measurement_are_visible(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys

    adapter = MemoryAdapter()
    flow = create_flow(adapter)
    flow.queue("broken")

    async def fail(name: str) -> None:
        raise RuntimeError("queue unreadable")

    monkeypatch.setattr(adapter, "get_queue_stats", fail)
    monkeypatch.setitem(sys.modules, "psutil", None)
    result = await flow.health_check()
    assert not result["healthy"]
    assert result["adapter"]["connected"]
    assert result["queues"] == [{"name": "broken", "healthy": False, "error": "queue unreadable"}]
    assert (
        next(check for check in result["checks"] if check["name"] == "memory")["status"] == "warn"
    )
    await flow.close()
