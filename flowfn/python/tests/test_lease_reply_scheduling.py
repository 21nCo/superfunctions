"""Native request-start lease scheduling under delayed successful replies."""
from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from flowfn.adapters.postgres import PostgresAdapter, PostgresSubscription
from flowfn.adapters.redis import RedisSubscription
from flowfn.queue.types import Job
from flowfn.stream.types import ConsumerOptions, Message
from flowfn.workflow.builder import WorkflowBuilder
from flowfn.workflow.types import ExecutionStatus, WorkflowContext
from tests.assertions import require_value
from tests.native_support import NativeAdapters


async def test_workflow_delayed_native_replies_keep_ownership(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, b = adapters
    original = a.transition_workflow_state
    timings: list[tuple[str, float]] = []
    renewals = 0
    async def delayed(identity: str, operation: str, payload: dict[str, Any]) -> Any:
        nonlocal renewals
        started = time.monotonic()
        result = await original(identity, operation, payload)
        if operation in ('claim', 'renew'):
            await asyncio.sleep(.45)
        if operation == 'renew' and result is not None:
            renewals += 1
        timings.append((operation, (time.monotonic()-started)*1000))
        return result
    monkeypatch.setattr(a, 'transition_workflow_state', delayed)
    entered, release, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def handler(context: WorkflowContext) -> None:
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
    workflow = WorkflowBuilder('delayed-reply', a).lease(1000).step('hold', handler).build()
    execution = await workflow.execute({})
    task = workflow._tasks[execution.id]
    try:
        await asyncio.wait_for(entered.wait(), 3)
        await asyncio.sleep(1.6)
        assert not cancelled.is_set(), timings
        assert renewals >= 2, timings
        assert not task.done()
        assert require_value(await b.load_workflow_state(execution.id)).status == ExecutionStatus.RUNNING
        release.set()
        await asyncio.wait_for(task, 3)
        assert require_value(await b.load_workflow_state(execution.id)).status == ExecutionStatus.COMPLETED
    finally:
        release.set()
        await workflow.close()


async def test_stream_delayed_native_replies_keep_ownership(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, b = adapters
    assert a.reclaim_after_ms == b.reclaim_after_ms == 1000
    subscription_type = PostgresSubscription if isinstance(a, PostgresAdapter) else RedisSubscription
    postgres_next, redis_next = PostgresSubscription._next, RedisSubscription._next
    postgres_owned, redis_owned = PostgresSubscription._owned, RedisSubscription._owned
    timings: list[tuple[str, float]] = []
    renewals = 0
    async def next_reply(self: PostgresSubscription | RedisSubscription, token: str) -> Any:
        started = time.monotonic()
        result = await postgres_next(self, token) if isinstance(self, PostgresSubscription) else await redis_next(self, token)
        if result:
            await asyncio.sleep(.45)
            timings.append(('claim', (time.monotonic()-started)*1000))
        return result
    async def owned_reply(self: PostgresSubscription | RedisSubscription, identity: int | str,
                          token: str, acknowledge: bool = False) -> bool:
        nonlocal renewals
        started = time.monotonic()
        if isinstance(self, PostgresSubscription):
            assert isinstance(identity, int)
            result = await postgres_owned(self, identity, token, acknowledge)
        else:
            assert isinstance(identity, str)
            result = await redis_owned(self, identity, token, acknowledge)
        if not acknowledge:
            await asyncio.sleep(.45)
            if result:
                renewals += 1
            timings.append(('renew', (time.monotonic()-started)*1000))
        return result
    monkeypatch.setattr(subscription_type, '_next', next_reply)
    monkeypatch.setattr(subscription_type, '_owned', owned_reply)
    entered, release, cancelled, completed = (asyncio.Event() for _ in range(4))
    deliveries: list[str] = []
    async def handler(message: Message) -> None:
        deliveries.append(message.id)
        entered.set()
        try:
            await release.wait()
            await message.ack()
            completed.set()
        except asyncio.CancelledError:
            cancelled.set()
            raise
    subscription = await a.consume('delayed-reply', 'group', 'reader', handler,
                                   ConsumerOptions(group_id='group', max_in_flight=1))
    await b.publish('delayed-reply', Message(id='one', stream='delayed-reply', data={}, timestamp=0))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        await asyncio.sleep(1.6)
        assert not cancelled.is_set(), timings
        assert renewals >= 2, timings
        assert deliveries == ['one']
        release.set()
        await asyncio.wait_for(completed.wait(), 3)
    finally:
        release.set()
        await subscription.unsubscribe()


async def test_workflow_cancellation_resistant_late_reply_is_fenced(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, b = adapters
    original = a.transition_workflow_state
    late = asyncio.Event()
    async def delayed(identity: str, operation: str, payload: dict[str, Any]) -> Any:
        result = await original(identity, operation, payload)
        if operation == 'renew' and result is not None and not late.is_set():
            try:
                await asyncio.sleep(2)
            except asyncio.CancelledError:
                late.set()
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
    workflow = WorkflowBuilder('resistant-reply', a).lease(1000).step('hold', handler).build()
    execution = await workflow.execute({})
    try:
        await asyncio.wait_for(entered.wait(), 3)
        await asyncio.wait_for(late.wait(), 2)
        await asyncio.wait_for(cancelled.wait(), .3)
        assert require_value(await b.load_workflow_state(execution.id)).status == ExecutionStatus.RUNNING
    finally:
        await workflow.close()


async def test_stream_cancellation_resistant_late_reply_is_fenced(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, _ = adapters
    assert a.reclaim_after_ms == 1000
    subscription_type = PostgresSubscription if isinstance(a, PostgresAdapter) else RedisSubscription
    postgres_owned, redis_owned = PostgresSubscription._owned, RedisSubscription._owned
    late = asyncio.Event()
    async def delayed(self: PostgresSubscription | RedisSubscription, identity: int | str,
                      token: str, acknowledge: bool = False) -> bool:
        if isinstance(self, PostgresSubscription):
            assert isinstance(identity, int)
            result = await postgres_owned(self, identity, token, acknowledge)
        else:
            assert isinstance(identity, str)
            result = await redis_owned(self, identity, token, acknowledge)
        if not acknowledge and result and not late.is_set():
            try:
                await asyncio.sleep(2)
            except asyncio.CancelledError:
                late.set()
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
    subscription = await a.consume('resistant-reply', 'group', 'reader', handler,
                                   ConsumerOptions(group_id='group', max_in_flight=1))
    await a.publish('resistant-reply', Message(id='one', stream='resistant-reply', data={}, timestamp=0))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        await asyncio.wait_for(late.wait(), 2)
        await asyncio.wait_for(cancelled.wait(), .3)
    finally:
        await subscription.unsubscribe()


async def test_queue_cancellation_resistant_late_reply_is_fenced(
    adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
) -> None:
    a, _ = adapters
    assert a.reclaim_after_ms == 1000
    original = a._transition
    late = asyncio.Event()
    async def delayed(method: str, *args: Any) -> Any:
        result = await original(method, *args)
        if method == '_renew_job' and not late.is_set():
            try:
                await asyncio.sleep(2)
            except asyncio.CancelledError:
                late.set()
        return result
    monkeypatch.setattr(a, '_transition', delayed)
    await a.enqueue('resistant-reply', Job(id='held', name='held', data={}, timestamp=0))
    claimed = await a.dequeue('resistant-reply')
    assert claimed is not None
    lost = a.lease_loss_event('resistant-reply', claimed)
    assert lost is not None
    await asyncio.wait_for(late.wait(), 2)
    await asyncio.wait_for(lost.wait(), .3)
