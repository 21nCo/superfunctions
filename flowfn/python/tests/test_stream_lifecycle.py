from __future__ import annotations

import asyncio

import pytest

from flowfn import create_flow
from flowfn.adapters.memory import MemoryAdapter
from flowfn.stream.types import Message


@pytest.mark.asyncio
async def test_decorator_registration_barrier_and_close_unsubscribe() -> None:
    flow = create_flow()
    stream = flow.stream("decorator")
    received = asyncio.Event()

    @stream.subscribe()
    async def handler(message: Message) -> None:
        received.set()

    assert callable(handler)
    await stream.publish("first")
    await asyncio.wait_for(received.wait(), 2)
    await stream.close()
    assert isinstance(flow._adapter, MemoryAdapter)
    assert flow._adapter._stream_subscribers["decorator"] == []
    with pytest.raises(RuntimeError, match="closed"):
        await stream.publish("late")
    await flow.close()


@pytest.mark.asyncio
async def test_awaited_subscription_can_unsubscribe() -> None:
    flow = create_flow()
    stream = flow.stream("awaited")

    async def handler(message: Message) -> None:
        pass

    subscription = await stream.subscribe(handler)
    await subscription.unsubscribe()
    assert isinstance(flow._adapter, MemoryAdapter)
    assert flow._adapter._stream_subscribers["awaited"] == []
    await flow.close()
