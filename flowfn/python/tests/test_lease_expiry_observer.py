"""Local expiry remains observable during a provider cancellation handshake."""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from flowfn.adapters.postgres import PostgresAdapter, PostgresSubscription
from flowfn.adapters.redis import RedisSubscription
from flowfn.queue.types import Job
from flowfn.stream.types import ConsumerOptions, Message
from flowfn.workflow.builder import WorkflowBuilder
from flowfn.workflow.types import WorkflowContext
from tests.native_support import NativeAdapters


class HeldCancellation:
    def __init__(self) -> None:
        self.cancelled = asyncio.Event()
        self.release = asyncio.Event()
        self.returned = asyncio.Event()
        self.calls = 0

    async def hold(self) -> None:
        self.calls += 1
        while not self.release.is_set():
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                # Model a driver that must finish its cancellation handshake.
                self.cancelled.set()
        self.returned.set()


async def test_queue_expiry_observed_while_renewal_cleanup_pending(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, _ = adapters
    held = HeldCancellation()
    original = a._transition
    async def delayed(method: str, *args: Any) -> Any:
        result = await original(method, *args)
        if method == '_renew_job':
            await held.hold()
        return result
    monkeypatch.setattr(a, '_transition', delayed)
    await a.enqueue('observer', Job(id='held', name='held', data={}, timestamp=0))
    job = await a.dequeue('observer')
    assert job is not None
    lost = a.lease_loss_event('observer', job)
    assert lost is not None
    try:
        await asyncio.wait_for(held.cancelled.wait(), 2)
        await asyncio.wait_for(lost.wait(), .3)
        assert not held.returned.is_set()
        assert a._job_heartbeats
        releasing = asyncio.create_task(a.release_job_lease('observer', job))
        await asyncio.sleep(.05)
        assert not releasing.done()
        assert a._pending_job_heartbeats
        held.release.set()
        await asyncio.wait_for(releasing, 1)
        assert held.returned.is_set()
        assert not a._pending_job_heartbeats
        assert lost.is_set()
        assert not a._job_heartbeats
        assert held.calls == 1
    finally:
        held.release.set()
        await a.release_job_lease('observer', job)


async def test_workflow_expiry_observed_while_renewal_cleanup_pending(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, _ = adapters
    held = HeldCancellation()
    original = a.transition_workflow_state
    async def delayed(identity: str, operation: str, payload: dict[str, Any]) -> Any:
        result = await original(identity, operation, payload)
        if operation == 'renew':
            await held.hold()
        return result
    monkeypatch.setattr(a, 'transition_workflow_state', delayed)
    entered, cancelled = asyncio.Event(), asyncio.Event()
    async def handler(context: WorkflowContext) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
    workflow = WorkflowBuilder('observer', a).lease(1000).step('hold', handler).build()
    execution = await workflow.execute({})
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.wait_for(held.cancelled.wait(), 2)
        await asyncio.wait_for(cancelled.wait(), .3)
        # Handler completion must not discard the pending provider task.
        await asyncio.sleep(0)
        assert execution.id in workflow._heartbeats
        assert not held.returned.is_set()
        closing = asyncio.create_task(workflow.close())
        await asyncio.sleep(.05)
        assert not closing.done()
        assert workflow._pending_heartbeats
        held.release.set()
        await asyncio.wait_for(closing, 2)
        assert not workflow._heartbeats
        assert held.returned.is_set()
        assert held.calls == 1
    finally:
        held.release.set()
        await workflow.close()


async def test_stream_expiry_observed_while_renewal_cleanup_pending(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, _ = adapters
    held = HeldCancellation()
    subscription_type = PostgresSubscription if isinstance(a, PostgresAdapter) else RedisSubscription
    postgres_owned, redis_owned = PostgresSubscription._owned, RedisSubscription._owned
    async def delayed(self: PostgresSubscription | RedisSubscription, identity: int | str,
                      token: str, acknowledge: bool = False) -> bool:
        if isinstance(self, PostgresSubscription):
            assert isinstance(identity, int)
            result = await postgres_owned(self, identity, token, acknowledge)
        else:
            assert isinstance(identity, str)
            result = await redis_owned(self, identity, token, acknowledge)
        if not acknowledge:
            await held.hold()
        return result
    monkeypatch.setattr(subscription_type, '_owned', delayed)
    entered, cancelled = asyncio.Event(), asyncio.Event()
    async def handler(message: Message) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
    subscription = await a.consume('observer', 'group', 'reader', handler,
                                   ConsumerOptions(group_id='group', max_in_flight=1))
    await a.publish('observer', Message(id='one', stream='observer', data={}, timestamp=0))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.wait_for(held.cancelled.wait(), 2)
        await asyncio.wait_for(cancelled.wait(), .3)
        assert not held.returned.is_set()
        closing = asyncio.create_task(subscription.unsubscribe())
        await asyncio.sleep(.05)
        assert not closing.done()
        held.release.set()
        await asyncio.wait_for(closing, 2)
        assert held.returned.is_set()
        assert held.calls == 1
    finally:
        held.release.set()
        await subscription.unsubscribe()


async def test_old_workflow_cleanup_cannot_remove_successor_heartbeat(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from flowfn.adapters.workflow_state import WorkflowLeaseError

    a, _ = adapters
    held = HeldCancellation()
    original = a.transition_workflow_state
    async def delayed(identity: str, operation: str, payload: dict[str, Any]) -> Any:
        result = await original(identity, operation, payload)
        if operation == 'renew' and held.calls == 0:
            await held.hold()
        return result
    monkeypatch.setattr(a, 'transition_workflow_state', delayed)
    entered = [asyncio.Event(), asyncio.Event()]
    cancelled: list[int] = []
    release_work = asyncio.Event()
    starts = 0
    async def handler(context: WorkflowContext) -> None:
        nonlocal starts
        generation = starts
        starts += 1
        entered[generation].set()
        try:
            await release_work.wait()
        except asyncio.CancelledError:
            cancelled.append(generation)
            raise
    workflow = WorkflowBuilder('successor', a).lease(1000).step('hold', handler).build()
    execution = await workflow.execute({})
    old_heartbeat = workflow._heartbeats[execution.id]
    try:
        await asyncio.wait_for(entered[0].wait(), 2)
        await asyncio.wait_for(held.cancelled.wait(), 2)
        # Wait for the real storage lease to become reclaimable, without changing it.
        async def resume() -> None:
            while True:
                try:
                    await workflow.resume_execution(execution.id)
                    return
                except WorkflowLeaseError:
                    await asyncio.sleep(.05)
        await asyncio.wait_for(resume(), 3)
        await asyncio.wait_for(entered[1].wait(), 2)
        current = workflow._heartbeats[execution.id]
        assert current is not old_heartbeat
        assert old_heartbeat in workflow._pending_heartbeats
        assert current in workflow._pending_heartbeats
        held.release.set()
        await asyncio.wait_for(asyncio.gather(old_heartbeat, return_exceptions=True), 1)
        assert workflow._heartbeats[execution.id] is current
        assert execution.id in workflow._lease_expiries
        assert cancelled == [0]
        release_work.set()
        await asyncio.wait_for(workflow._tasks[execution.id], 2)
        await workflow.close()
        assert not workflow._pending_heartbeats
        assert not workflow._lease_expiries
    finally:
        held.release.set()
        release_work.set()
        await workflow.close()
