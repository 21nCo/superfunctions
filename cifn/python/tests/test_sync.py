"""Tests for sync wrappers (TV-SYNC-001, TV-SYNC-002)."""

from __future__ import annotations

import pytest

from cifn.types import TriggerInput, TriggerType
from tests.conftest import make_client, mock_transport

# --- TV-SYNC-001: Sync wrapper produces same result as async ---


@pytest.mark.asyncio
async def test_list_runs_sync_same_result_as_async() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs"): (
                200,
                {
                    "ok": True,
                    "data": {
                        "runs": [
                            {
                                "id": "r1",
                                "trigger": {"type": "push"},
                                "status": "success",
                                "createdAt": "2026-02-15T10:00:00Z",
                                "updatedAt": "2026-02-15T10:01:00Z",
                            }
                        ],
                        "nextCursor": None,
                    },
                },
            )
        }
    )
    client = make_client(transport)
    async_result = await client.list_runs()
    sync_result = client.list_runs_sync()
    assert len(async_result.runs) == len(sync_result.runs) == 1
    assert async_result.runs[0].id == sync_result.runs[0].id == "r1"
    assert async_result.next_cursor == sync_result.next_cursor


@pytest.mark.asyncio
async def test_get_run_sync_same_result_as_async() -> None:
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs/run-abc"): (
                200,
                {
                    "ok": True,
                    "data": {
                        "id": "run-abc",
                        "trigger": {"type": "push"},
                        "status": "queued",
                        "createdAt": "2026-02-15T10:00:00Z",
                        "updatedAt": "2026-02-15T10:00:00Z",
                        "jobs": [],
                    },
                },
            )
        }
    )
    client = make_client(transport)
    async_result = await client.get_run("run-abc")
    sync_result = client.get_run_sync("run-abc")
    assert async_result.id == sync_result.id == "run-abc"
    assert async_result.status == sync_result.status


def test_sync_wrapper_no_event_loop() -> None:
    """Sync wrapper works when no event loop is running."""
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs"): (
                200,
                {"ok": True, "data": {"runs": [], "nextCursor": None}},
            )
        }
    )
    client = make_client(transport)
    result = client.list_runs_sync()
    assert result.runs == []
    assert result.next_cursor is None


# --- TV-SYNC-002: Sync wrapper works when event loop is already running ---


@pytest.mark.asyncio
async def test_create_run_sync_when_loop_already_running() -> None:
    """Call create_run_sync from inside an async context (e.g. Jupyter)."""
    from cifn.types import PipelineRef

    transport = mock_transport(
        {
            ("POST", "/api/v1/runs"): (
                201,
                {
                    "ok": True,
                    "data": {
                        "runId": "run-new",
                        "status": "queued",
                        "createdAt": "2026-02-15T12:00:00Z",
                    },
                },
            )
        }
    )
    client = make_client(transport)
    trigger = TriggerInput(type=TriggerType.PUSH)
    pipeline_ref = PipelineRef(repo="x", ref="main")

    async def outer() -> None:
        # From within running event loop, sync wrapper should not raise RuntimeError
        result = client.create_run_sync(trigger, pipeline_ref=pipeline_ref)
        assert result.run_id == "run-new"
        assert result.status.value == "queued"

    await outer()


@pytest.mark.asyncio
async def test_list_runs_sync_from_async_context() -> None:
    """Sync wrapper from within asyncio.run() context (nested)."""
    transport = mock_transport(
        {
            ("GET", "/api/v1/runs"): (
                200,
                {"ok": True, "data": {"runs": [], "nextCursor": "c1"}},
            )
        }
    )
    client = make_client(transport)

    async def async_caller() -> None:
        sync_result = client.list_runs_sync(limit=10)
        assert sync_result.next_cursor == "c1"

    await async_caller()
