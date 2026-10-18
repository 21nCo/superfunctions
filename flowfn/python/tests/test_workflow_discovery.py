import pytest

from flowfn import create_flow
from flowfn.adapters.memory import MemoryAdapter
from flowfn.workflow.types import WorkflowExecution, ExecutionStatus, ListOptions


async def test_workflow_discovery_reads_adapter_and_enforces_definition_scope():
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
    assert (await adapter.load_workflow_state('other')).status == ExecutionStatus.COMPLETED
    await flow.close()


async def test_event_history_survives_new_instance_and_records_compensation_failure():
    import asyncio
    adapter = MemoryAdapter()
    flow = create_flow(adapter)

    async def execute(context):
        context.set('reserved',True)

    async def compensate(context):
        raise ValueError('refund unavailable')

    async def fail(context):
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
    restored.state.clear()
    assert (await adapter.load_workflow_state(execution.id)).state['events']
    assert (await fresh.get_metrics())['failed'] == 1
    await flow.close()
