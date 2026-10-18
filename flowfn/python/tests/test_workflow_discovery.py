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
