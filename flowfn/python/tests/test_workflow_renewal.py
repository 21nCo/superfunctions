"""Workflow renewal retries transient failures only inside the owned lease."""
import asyncio

import pytest

from flowfn.adapters.workflow_state import WorkflowLeaseError
from flowfn.workflow.builder import WorkflowBuilder
from flowfn.workflow.types import ExecutionStatus
from tests.test_durable_adapters import adapters  # noqa: F401


@pytest.mark.parametrize('failure',['lost','hung'])
async def test_workflow_renewal_loss_cancels_without_stale_state(adapters,monkeypatch,failure):
    a,b=adapters
    original=a.transition_workflow_state
    async def transition(identity,operation,payload):
        if operation=='renew':
            if failure=='hung':
                await asyncio.Event().wait()
            return None
        return await original(identity,operation,payload)
    monkeypatch.setattr(a,'transition_workflow_state',transition)
    entered,cancelled=asyncio.Event(),asyncio.Event()
    async def handler(ctx):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
    workflow=WorkflowBuilder('renewal',a).lease(1000).step('wait',handler).build()
    execution=await workflow.execute({})
    try:
        await asyncio.wait_for(entered.wait(),3)
        await asyncio.wait_for(cancelled.wait(),3)
        await asyncio.sleep(0)
        assert (await b.load_workflow_state(execution.id)).status==ExecutionStatus.RUNNING
    finally:
        await workflow.close()


async def test_workflow_transient_renewal_error_recovers_before_deadline(adapters,monkeypatch):
    a,b=adapters
    original=a.transition_workflow_state
    recovered,release=asyncio.Event(),asyncio.Event()
    calls=0
    async def transition(identity,operation,payload):
        nonlocal calls
        if operation=='renew':
            calls+=1
            if calls==1:
                raise ConnectionError('transient transport failure')
        result=await original(identity,operation,payload)
        if operation=='renew' and result is not None:
            recovered.set()
        return result
    monkeypatch.setattr(a,'transition_workflow_state',transition)
    async def handler(ctx):
        await release.wait()
    workflow=WorkflowBuilder('transient',a).lease(2000).step('wait',handler).build()
    execution=await workflow.execute({})
    task=workflow._tasks[execution.id]
    with pytest.raises(WorkflowLeaseError,match="active local runtime"):
        await workflow.resume_execution(execution.id)
    assert workflow._tasks[execution.id] is task
    try:
        await asyncio.wait_for(recovered.wait(),3)
        assert not task.done()
        release.set()
        await asyncio.wait_for(task,3)
        assert (await b.load_workflow_state(execution.id)).status==ExecutionStatus.COMPLETED
        assert calls>=2
    finally:
        release.set()
        await workflow.close()


async def test_late_workflow_claim_reply_never_starts_handler(adapters,monkeypatch):
    a,b=adapters
    original=a.transition_workflow_state
    async def transition(identity,operation,payload):
        result=await original(identity,operation,payload)
        if operation=='claim':
            await asyncio.sleep(.25)
        return result
    monkeypatch.setattr(a,'transition_workflow_state',transition)
    called=[]
    async def handler(ctx):
        called.append(True)
    workflow=WorkflowBuilder('late',a).lease(200).step('work',handler).build()
    try:
        with pytest.raises(WorkflowLeaseError,match='claim reply'):
            await workflow.execute({})
        assert called==[]
        assert workflow._tasks=={}
    finally:
        await workflow.close()
