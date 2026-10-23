from __future__ import annotations

import pytest

from flowfn import create_flow
from flowfn.adapters.memory import MemoryAdapter
from flowfn.workflow.types import ExecutionStatus, ListOptions, WorkflowContext, WorkflowExecution
from tests.assertions import require_value


async def test_workflow_discovery_reads_adapter_and_enforces_definition_scope() -> None:
    adapter = MemoryAdapter()
    flow = create_flow(adapter)
    workflow = flow.workflow('orders').build()
    for identity, name, created in [('a','orders',1),('b','orders',2),('other','payments',3)]:
        await adapter.save_workflow_state(identity,WorkflowExecution(
            id=identity,workflow_id=name,input={},status=ExecutionStatus.COMPLETED,
            started_at=created,created_at=created,updated_at=created))
    listed = await workflow.list_executions(ListOptions(limit=1))
    assert [item.id for item in listed] == ['b']
    assert [item.id for item in await workflow.list_executions(ListOptions(offset=1))] == ['a']
    with pytest.raises(ValueError,match='Execution not found'):
        await workflow.cancel_execution('other')
    assert (require_value(await adapter.load_workflow_state('other'))).status == ExecutionStatus.COMPLETED
    await flow.close()


async def test_event_history_survives_new_instance_and_records_compensation_failure() -> None:
    import asyncio
    adapter = MemoryAdapter()
    flow = create_flow(adapter)

    async def execute(context: WorkflowContext) -> None:
        context.set('reserved',True)

    async def compensate(context: WorkflowContext) -> None:
        raise ValueError('refund unavailable')

    async def fail(context: WorkflowContext) -> None:
        raise ValueError('shipping failed')

    workflow = flow.workflow('orders').saga('reserve',execute,compensate).step('ship',fail).build()
    execution = await workflow.execute({})
    for _ in range(100):
        if execution.status == ExecutionStatus.FAILED:
            break
        await asyncio.sleep(.01)
    assert execution.status == ExecutionStatus.FAILED
    fresh = flow.workflow('orders').build()
    history = await fresh.get_execution_history(execution.id)
    failure = next(event for event in history if event.type == 'saga.compensation_failed')
    assert failure.data == {'saga':'reserve','error':'refund unavailable'}
    assert history[-1].type == 'execution.failed'
    restored = await adapter.load_workflow_state(execution.id)
    assert restored is not None
    restored.state.clear()
    assert (require_value(await adapter.load_workflow_state(execution.id))).state['events']
    assert (await fresh.get_metrics())['failed'] == 1
    await flow.close()


async def test_nested_branch_and_saga_restore_from_abandoned_owner() -> None:
    import asyncio
    adapter=MemoryAdapter()
    flow=create_flow(adapter)
    entered=asyncio.Event()
    compensated=[]

    async def reserve(ctx: WorkflowContext) -> None:
        ctx.set('reservation','kept')

    async def compensate(ctx: WorkflowContext) -> None:
        compensated.append(ctx.get('reservation'))

    async def hold(ctx: WorkflowContext) -> None:
        entered.set()
        await asyncio.Event().wait()

    branch=flow.workflow('branch').saga('reserve',reserve,compensate).step('hold',hold)
    original=flow.workflow('nested').lease(100).branch(lambda ctx:True,then_workflow=branch).build()
    execution=await original.execute({})
    await entered.wait()
    original._lease_lost.add(execution.id)
    task=original._tasks[execution.id]
    task.cancel()
    await asyncio.gather(task,return_exceptions=True)
    await asyncio.sleep(.15)

    async def do_not_replay(ctx: WorkflowContext) -> None:
        raise AssertionError('Completed saga replayed')

    async def fail(ctx: WorkflowContext) -> None:
        raise ValueError('finish failed')

    restored_branch=flow.workflow('branch').saga('reserve',do_not_replay,compensate).step('hold',fail)
    restored=flow.workflow('nested').lease(100).branch(lambda ctx:False,then_workflow=restored_branch).build()
    resumed=await restored.resume_execution(execution.id)
    for _ in range(100):
        if resumed.status==ExecutionStatus.FAILED:
            break
        await asyncio.sleep(.01)
    assert resumed.status==ExecutionStatus.FAILED and resumed.error=='finish failed'
    assert compensated==['kept']
    await flow.close()


async def test_crashed_compensation_resumes_compensation_phase() -> None:
    import asyncio
    adapter=MemoryAdapter()
    flow=create_flow(adapter)
    entered=asyncio.Event()
    calls=[]

    async def reserve(ctx: WorkflowContext) -> None:
        pass
    async def compensate(ctx: WorkflowContext) -> None:
        entered.set()
        await asyncio.Event().wait()
    async def fail(ctx: WorkflowContext) -> None:
        raise ValueError('original failure')

    original=flow.workflow('compensation').lease(100).saga('reserve',reserve,compensate).step('fail',fail).build()
    execution=await original.execute({})
    await entered.wait()
    original._lease_lost.add(execution.id)
    task=original._tasks[execution.id]
    task.cancel()
    await asyncio.gather(task,return_exceptions=True)
    await asyncio.sleep(.15)

    async def recovered_compensation(ctx: WorkflowContext) -> None:
        calls.append('compensated')
    async def do_not_execute(ctx: WorkflowContext) -> None:
        raise AssertionError('Forward phase replayed')

    restored=flow.workflow('compensation').lease(100).saga('reserve',do_not_execute,recovered_compensation).step('fail',do_not_execute).build()
    resumed=await restored.resume_execution(execution.id)
    for _ in range(100):
        if resumed.status==ExecutionStatus.FAILED:
            break
        await asyncio.sleep(.01)
    assert resumed.error=='original failure' and calls==['compensated']
    await flow.close()
