"""Unconfigured Memory receipt lifetime and retained-payload contracts."""
from __future__ import annotations

import asyncio

from flowfn import create_flow
from flowfn.stream.types import ConsumerOptions, Message, TrimStrategy


async def test_returned_manual_callback_expires_and_redelivers() -> None:
    flow = create_flow()
    stream = flow.stream('legacy-expiry')
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    async def handler(message: Message) -> None:
        deliveries.put_nowait(message)
    try:
        identity = await stream.publish(1)
        consumer = stream.create_consumer('one', ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=1, visibility_timeout=100))
        await consumer.subscribe(handler)
        old = await asyncio.wait_for(deliveries.get(), 1)
        replacement = await asyncio.wait_for(deliveries.get(), .5)
        assert replacement.id == old.id == identity
        await old.ack()
        await replacement.ack()
    finally:
        await flow.close()


async def test_trim_deletes_held_and_unread_payloads_without_hidden_redelivery() -> None:
    flow = create_flow()
    stream = flow.stream('legacy-trim')
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    async def handler(message: Message) -> None:
        deliveries.put_nowait(message)
    try:
        await stream.publish('held')
        await stream.publish('unread')
        consumer = stream.create_consumer('one', ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=1, visibility_timeout=100))
        await consumer.subscribe(handler)
        old = await asyncio.wait_for(deliveries.get(), 1)
        assert await stream.trim(TrimStrategy(max_length=0)) == 2
        assert await stream.get_messages('', '\uffff') == []
        await asyncio.sleep(.15)
        assert deliveries.empty()
        identity = await stream.publish('next')
        current = await asyncio.wait_for(deliveries.get(), 1)
        assert current.id == identity
        await old.ack()
        await current.ack()
    finally:
        await flow.close()


async def test_legacy_preserves_cross_message_concurrency_and_stale_receipt_fencing() -> None:
    flow = create_flow()
    stream = flow.stream('legacy-concurrency')
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    gate = asyncio.Event()
    async def held(message: Message) -> None:
        deliveries.put_nowait(message)
        await gate.wait()
    try:
        identities = {await stream.publish(1), await stream.publish(2)}
        consumer = stream.create_consumer('one', ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=2, visibility_timeout=100))
        await consumer.subscribe(held)
        first = await asyncio.wait_for(deliveries.get(), 1)
        second = await asyncio.wait_for(deliveries.get(), 1)
        assert {first.id, second.id} == identities
        await asyncio.sleep(.25)
        assert deliveries.empty()  # Both active callbacks retain independent leases.
        gate.set()
        replacements = [await asyncio.wait_for(deliveries.get(), 1) for _ in range(2)]
        assert {message.id for message in replacements} == identities
        await first.ack()
        await second.ack()
        # Stale ACKs cannot stop the replacements from expiring/redelivering.
        latest = [await asyncio.wait_for(deliveries.get(), 1) for _ in range(2)]
        assert {message.id for message in latest} == identities
        for message in latest:
            await message.ack()
    finally:
        gate.set()
        await flow.close()


async def test_legacy_unsubscribe_redelivers_retained_current_message_only() -> None:
    flow = create_flow()
    stream = flow.stream('legacy-close')
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    async def receive(message: Message) -> None:
        deliveries.put_nowait(message)
    try:
        identity = await stream.publish(1)
        options = ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=1)
        old_consumer = stream.create_consumer('same', options)
        await old_consumer.subscribe(receive)
        old = await asyncio.wait_for(deliveries.get(), 1)
        await old_consumer.close()
        new_consumer = stream.create_consumer('same', options)
        await new_consumer.subscribe(receive)
        replacement = await asyncio.wait_for(deliveries.get(), 1)
        assert replacement.id == old.id == identity
        await old.ack()
        await replacement.ack()
    finally:
        await flow.close()
