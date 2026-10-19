"""Closing a stale local runtime cannot cancel a replacement worker's execution."""
import asyncio
import json
from urllib.parse import quote

from flowfn.workflow.builder import WorkflowBuilder
from flowfn.workflow.types import ExecutionStatus
from tests.test_durable_adapters import adapters  # noqa: F401


async def test_stale_workflow_close_preserves_reclaimed_execution(adapters,monkeypatch):
    a,b=adapters
    entered,replaced=asyncio.Event(),asyncio.Event()
    async def old_step(ctx):
        entered.set()
        await asyncio.Event().wait()
    async def new_step(ctx):
        replaced.set()
        await asyncio.Event().wait()
    old=WorkflowBuilder('handoff',a).step('work',old_step).build()
    new=WorkflowBuilder('handoff',b).step('work',new_step).build()
    async def no_renew(execution):
        await asyncio.Event().wait()
    monkeypatch.setattr(old,'_renew',no_renew)
    execution=await old.execute({})
    await asyncio.wait_for(entered.wait(),5)
    if hasattr(a,'client'):
        key=a.prefix+':workflow:'+quote(execution.id,safe='')
        record=json.loads(await a.client.get(key))
        record['lease_expires_at']=0
        await a.client.set(key,json.dumps(record))
    else:
        pool=await a._database()
        await pool.execute("UPDATE flowfn_py_workflows SET payload=jsonb_set(payload,'{lease_expires_at}','0'::jsonb) WHERE namespace=$1 AND id=$2",a.namespace,execution.id)
    replacement=await new.resume_execution(execution.id)
    await asyncio.wait_for(replaced.wait(),5)
    try:
        await old.close()
        persisted=await b.load_workflow_state(execution.id)
        assert persisted.status==ExecutionStatus.RUNNING
        assert persisted.lease_token==replacement.lease_token
        assert not new._tasks[execution.id].done()
    finally:
        await new.close()
        await old.close()
    assert (await b.load_workflow_state(execution.id)).status==ExecutionStatus.CANCELLED
