"""Recovery tests kill a real Python worker while Redis/Postgres retains state."""

from __future__ import annotations

import asyncio
import json
import sys

import pytest

from flowfn import create_flow
from flowfn.adapters.redis import RedisAdapter
from flowfn.adapters.workflow_state import WorkflowLeaseError
from flowfn.core.flow import FlowFn
from flowfn.workflow.types import ExecutionStatus, WorkflowContext
from flowfn.workflow.workflow import Workflow
from tests.assertions import require_value
from tests.native_support import NativeAdapters

CHILD = r'''
import asyncio,json,sys
from flowfn import create_flow
from flowfn.adapters.redis import RedisAdapter
from flowfn.adapters.postgres import PostgresAdapter
async def main():
 cls=RedisAdapter if sys.argv[1]=='redis' else PostgresAdapter
 flow=create_flow(cls(sys.argv[2],namespace=sys.argv[3]))
 async def first(ctx): ctx.set('first',42)
 async def parallel_done(ctx): ctx.set('parallel',7)
 async def blocked(ctx):
  print('blocked',flush=True)
  await asyncio.Event().wait()
 workflow=flow.workflow('recover').version('v1').lease(1000).step('first',first).parallel([parallel_done,blocked]).build()
 execution=await workflow.execute({})
 print(json.dumps({'id':execution.id}),flush=True)
 await asyncio.Event().wait()
asyncio.run(main())
'''


async def test_process_crash_resume_checkpoints_versions_and_fencing(adapters: NativeAdapters) -> None:
    a,b = adapters
    backend = 'redis' if isinstance(a, RedisAdapter) else 'postgres'
    process = await asyncio.create_subprocess_exec(sys.executable,'-c',CHILD,backend,a.test_url,a.namespace,
                                                   stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    assert process.stdout is not None
    try:
        line = await asyncio.wait_for(process.stdout.readline(),10)
        execution_id = json.loads(line)['id']
        assert (require_value(await asyncio.wait_for(process.stdout.readline(),10))).strip() == b'blocked'
        for _ in range(100):
            snapshot = await a.load_workflow_state(execution_id)
            assert snapshot is not None
            if '/1/0' in snapshot.state.get('completed_steps',[]):
                break
            await asyncio.sleep(.02)
        assert snapshot is not None
        assert '/0' in snapshot.state['completed_steps'] and '/1/0' in snapshot.state['completed_steps']
        process.kill()
        await process.wait()
        await asyncio.sleep(1.2)
        flow_a,flow_b = create_flow(a),create_flow(b)

        async def already_completed(ctx: WorkflowContext) -> None:
            raise AssertionError('Completed step replayed')

        async def finish(ctx: WorkflowContext) -> None:
            assert ctx.get('first') == 42 and ctx.get('parallel') == 7
            ctx.set('finished',True)

        def definition(flow: FlowFn,version: str='v1') -> Workflow:
            return flow.workflow('recover').version(version).lease(1000).step('first',already_completed).parallel([already_completed,finish]).build()

        with pytest.raises(ValueError,match='definition'):
            await definition(flow_a,'v2').resume_execution(execution_id)
        wa,wb = definition(flow_a),definition(flow_b)
        results = await asyncio.gather(wa.resume_execution(execution_id),wb.resume_execution(execution_id),return_exceptions=True)
        assert sum(not isinstance(item,Exception) for item in results) == 1, results
        assert sum(isinstance(item,WorkflowLeaseError) for item in results) == 1, results
        for _ in range(200):
            recovered = await a.load_workflow_state(execution_id)
            assert recovered is not None
            if recovered.status == ExecutionStatus.COMPLETED:
                break
            await asyncio.sleep(.02)
        assert recovered is not None
        assert recovered.status == ExecutionStatus.COMPLETED and recovered.context['finished']
        assert recovered.lease_token != snapshot.lease_token
        with pytest.raises(WorkflowLeaseError):
            await b.save_workflow_state(execution_id,snapshot)
        await flow_a.close()
        await flow_b.close()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_remote_cancel_invalidates_live_owner(adapters: NativeAdapters) -> None:
    a,b = adapters
    flow_a,flow_b = create_flow(a),create_flow(b)
    started,stopped = asyncio.Event(),asyncio.Event()

    async def hold(ctx: WorkflowContext) -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    wa = flow_a.workflow('cancel').lease(1000).step('hold',hold).build()
    wb = flow_b.workflow('cancel').lease(1000).step('hold',hold).build()
    execution = await wa.execute({})
    await asyncio.wait_for(started.wait(),3)
    await asyncio.sleep(2.2)
    with pytest.raises(WorkflowLeaseError):
        await wb.resume_execution(execution.id)
    await wb.cancel_execution(execution.id)
    await asyncio.wait_for(stopped.wait(),3)
    assert (require_value(await b.load_workflow_state(execution.id))).status == ExecutionStatus.CANCELLED
    await flow_a.close()
    await flow_b.close()
