"""Global shutdown fences admission and bounds the caller's wait safely."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from flowfn import create_flow
from flowfn.adapters.memory import MemoryAdapter
from flowfn.queue.types import Job
from flowfn.stream.types import ConsumerOptions, Message
from flowfn.workflow.types import WorkflowContext, WorkflowExecution
from tests.native_support import NativeAdapters


class ObservedMemory(MemoryAdapter):
    def __init__(self) -> None:
        super().__init__()
        self.cleaned=0
    async def cleanup(self) -> None:
        self.cleaned+=1
        await super().cleanup()


async def test_one_shutdown_deadline_fences_all_resources_and_preserves_adapter() -> None:
    adapter=ObservedMemory()
    flow=create_flow(adapter)
    queue=flow.queue('blocked')
    stream=flow.stream('other')
    builder=flow.workflow('late-build')
    consumer=stream.create_consumer('late-consumer',ConsumerOptions(group_id='group'))
    entered,release=asyncio.Event(),asyncio.Event()
    async def handler(job: Job) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release.wait()
    queue.process(handler)
    await queue.add('one',{})
    await asyncio.wait_for(entered.wait(),1)
    async def handler_message(message: Message) -> None:
        pass
    try:
        with pytest.raises(TimeoutError):
            await flow.close(timeout=.02)
        assert adapter.cleaned==0
        assert stream._closed
        for factory in (lambda:flow.queue('new'),lambda:flow.stream('new'),lambda:flow.workflow('new'),builder.build):
            with pytest.raises(RuntimeError,match='closed'):
                factory()
        with pytest.raises(RuntimeError,match='closed'):
            await queue.add('late',{})
        with pytest.raises(RuntimeError,match='closed'):
            await stream.publish('late')
        with pytest.raises(RuntimeError,match='closed'):
            await consumer.subscribe(handler_message)
    finally:
        release.set()
        await flow.close(timeout=2)
    await flow.close()
    assert adapter.cleaned==1


async def test_admitted_enqueue_finishes_before_adapter_cleanup(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter=ObservedMemory()
    flow=create_flow(adapter)
    queue=flow.queue('publish')
    entered,release=asyncio.Event(),asyncio.Event()
    original=adapter.enqueue
    async def blocked(*args: Any) -> Any:
        entered.set()
        await release.wait()
        assert adapter.cleaned==0
        return await original(*args)
    monkeypatch.setattr(adapter,'enqueue',blocked)
    publish=asyncio.create_task(queue.add('one',{}))
    await entered.wait()
    with pytest.raises(TimeoutError):
        await flow.close(timeout=.01)
    assert adapter.cleaned==0
    release.set()
    await publish
    await flow.close(timeout=1)
    assert adapter.cleaned==1


async def test_cancelled_close_waiter_does_not_cancel_shared_cleanup(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter=ObservedMemory()
    flow=create_flow(adapter)
    queue=flow.queue('blocked')
    entered,release=asyncio.Event(),asyncio.Event()
    async def blocked_close() -> None:
        entered.set()
        await release.wait()
    monkeypatch.setattr(queue,'close',blocked_close)
    first=asyncio.create_task(flow.close())
    await entered.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert flow._close_task is not None
    assert not flow._close_task.done()
    release.set()
    await flow.close(timeout=1)
    assert adapter.cleaned==1


async def test_admitted_workflow_does_not_start_handler_after_close(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter=ObservedMemory()
    flow=create_flow(adapter)
    entered,release=asyncio.Event(),asyncio.Event()
    calls=[]
    async def step(ctx: WorkflowContext) -> None:
        calls.append(True)
    workflow=flow.workflow('startup').step('one',step).build()
    original=workflow._persist
    async def blocked(execution: WorkflowExecution) -> None:
        entered.set()
        await release.wait()
        await original(execution)
    monkeypatch.setattr(workflow,'_persist',blocked)
    execution=asyncio.create_task(workflow.execute({}))
    await entered.wait()
    with pytest.raises(TimeoutError):
        await flow.close(timeout=.01)
    assert adapter.cleaned==0
    release.set()
    result=await execution
    await flow.close(timeout=1)
    assert calls==[]
    assert result.status.value=='cancelled'
    assert adapter.cleaned==1




@pytest.mark.parametrize('operation',['enqueue','publish'])
async def test_durable_admission_survives_shutdown_and_client_reconstruction(adapters: NativeAdapters,monkeypatch: pytest.MonkeyPatch,operation: str) -> None:
    adapter,observer=adapters
    flow=create_flow(adapter)
    entered,release=asyncio.Event(),asyncio.Event()
    original=getattr(adapter,operation)
    async def blocked(*args: Any) -> Any:
        entered.set()
        await release.wait()
        return await original(*args)
    monkeypatch.setattr(adapter,operation,blocked)
    admitted: asyncio.Task[Job] | asyncio.Task[str]
    if operation == 'enqueue':
        admitted = asyncio.create_task(flow.queue('shutdown').add('one', {}))
    else:
        admitted = asyncio.create_task(flow.stream('shutdown').publish('one'))
    await entered.wait()
    with pytest.raises(TimeoutError):
        await flow.close(timeout=.01)
    release.set()
    await admitted
    await flow.close(timeout=5)
    persisted=await observer.get_all_jobs('shutdown') if operation=='enqueue' else await observer.get_stream_messages('shutdown')
    assert len(persisted)==1
