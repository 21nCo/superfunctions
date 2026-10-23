from __future__ import annotations

import asyncio

import pytest

from flowfn import create_flow
from flowfn.adapters.memory import MemoryAdapter
from flowfn.workflow.types import WorkflowContext, WorkflowExecution
from flowfn.workflow.workflow import Workflow
from tests.assertions import require_value


async def terminal(workflow: Workflow, execution: WorkflowExecution) -> None:
    async def wait() -> None:
        while (require_value(await workflow.get_execution(execution.id))).status.value == "running":
            await asyncio.sleep(0)

    await asyncio.wait_for(wait(), 2)


@pytest.mark.asyncio
async def test_cancel_awaits_handler_cleanup_and_never_completes() -> None:
    flow = create_flow()
    entered, stopped = asyncio.Event(), asyncio.Event()
    later = []

    async def blocking(ctx: WorkflowContext) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    async def next_step(ctx: WorkflowContext) -> None:
        later.append(True)

    workflow = flow.workflow("cancel").step("block", blocking).step("later", next_step).build()
    run = await workflow.execute({})
    await asyncio.wait_for(entered.wait(), 2)
    await workflow.cancel_execution(run.id)
    assert stopped.is_set()
    assert run.status.value == "cancelled"
    assert not later
    assert "execution.completed" not in [
        e.type for e in await workflow.get_execution_history(run.id)
    ]
    await flow.close()


@pytest.mark.asyncio
async def test_compensation_is_isolated_between_concurrent_executions() -> None:
    flow = create_flow()
    ready, release = asyncio.Event(), asyncio.Event()
    compensated = []

    async def action(ctx: WorkflowContext) -> None:
        if ctx.input == "success":
            ready.set()
            await release.wait()

    async def compensate(ctx: WorkflowContext) -> None:
        compensated.append(ctx.input)

    async def fail(ctx: WorkflowContext) -> None:
        if ctx.input == "failure":
            raise ValueError("expected")

    workflow = flow.workflow("saga").saga("action", action, compensate).step("fail", fail).build()
    success = await workflow.execute("success")
    await asyncio.wait_for(ready.wait(), 2)
    failure = await workflow.execute("failure")
    await terminal(workflow, failure)
    release.set()
    await terminal(workflow, success)
    assert compensated == ["failure"]
    assert success.status.value == "completed"
    await flow.close()


@pytest.mark.asyncio
async def test_parallel_failure_awaits_sibling_cleanup() -> None:
    flow = create_flow()
    started, stopped = asyncio.Event(), asyncio.Event()

    async def pending(ctx: WorkflowContext) -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    async def fail(ctx: WorkflowContext) -> None:
        await started.wait()
        raise ValueError("expected")

    workflow = flow.workflow("parallel").parallel([pending, fail]).build()
    run = await workflow.execute({})
    await terminal(workflow, run)
    assert run.status.value == "failed"
    assert stopped.is_set()
    await flow.close()


@pytest.mark.asyncio
async def test_flow_close_stops_workflows_before_adapter_cleanup() -> None:
    flow = create_flow()
    started, stopped = asyncio.Event(), asyncio.Event()

    async def pending(ctx: WorkflowContext) -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    workflow = flow.workflow("close").step("pending", pending).build()
    await workflow.execute({})
    await asyncio.wait_for(started.wait(), 2)
    assert await flow.list_workflows() == [workflow]
    await flow.close()
    assert stopped.is_set()
    assert isinstance(flow._adapter, MemoryAdapter)
    assert not flow._adapter._workflow_states
    with pytest.raises(RuntimeError, match="closed"):
        await workflow.execute({})
