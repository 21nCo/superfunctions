"""Closing a stale local runtime cannot cancel a replacement worker's execution."""

from __future__ import annotations

import asyncio
import json
from urllib.parse import quote

import pytest

from flowfn.adapters.redis import RedisAdapter
from flowfn.workflow.builder import WorkflowBuilder
from flowfn.workflow.types import ExecutionStatus, WorkflowContext, WorkflowExecution
from tests.assertions import require_value
from tests.native_support import NativeAdapters


async def test_stale_workflow_close_preserves_reclaimed_execution(adapters: NativeAdapters,monkeypatch: pytest.MonkeyPatch) -> None:
    a,b=adapters
    entered,replaced=asyncio.Event(),asyncio.Event()
    async def old_step(ctx: WorkflowContext) -> None:
        entered.set()
        await asyncio.Event().wait()
    async def new_step(ctx: WorkflowContext) -> None:
        replaced.set()
        await asyncio.Event().wait()
    old=WorkflowBuilder('handoff',a).step('work',old_step).build()
    new=WorkflowBuilder('handoff',b).step('work',new_step).build()
    async def no_renew(execution: WorkflowExecution) -> None:
        await asyncio.Event().wait()
    monkeypatch.setattr(old,'_renew',no_renew)
    execution=await old.execute({})
    await asyncio.wait_for(entered.wait(),5)
    if isinstance(a, RedisAdapter):
        key=a.prefix+':workflow:'+quote(execution.id,safe='')
        raw_record = await a.client.get(key)
        assert isinstance(raw_record, (str, bytes))
        record=json.loads(raw_record)
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
        assert persisted is not None
        assert persisted.status==ExecutionStatus.RUNNING
        assert persisted.lease_token==replacement.lease_token
        assert not new._tasks[execution.id].done()
    finally:
        await new.close()
        await old.close()
    assert (require_value(await b.load_workflow_state(execution.id))).status==ExecutionStatus.CANCELLED
