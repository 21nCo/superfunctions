"""Configured Memory stream partition routing and ownership contracts."""
from __future__ import annotations

import asyncio

import pytest

from flowfn import create_flow
from flowfn.adapters.memory import MemoryAdapter
from flowfn.stream.stream import Stream
from flowfn.stream.types import ConsumerOptions, Message, PublishOptions


async def test_partition_policy_routing_reopen_and_global_history() -> None:
    adapter = MemoryAdapter()
    stream = Stream('events', adapter, {'partitions': 3})
    reopened = Stream('events', adapter)
    try:
        first = await stream.publish(1, PublishOptions(key='tenantα'))
        second = await reopened.publish(2, PublishOptions(key='tenantα'))
        messages = await adapter.get_stream_messages('events')
        assert [(message.id, message.partition) for message in messages] == [(first, 2), (second, 2)]
        assert (await reopened.get_info()).model_dump()['partitions'] == 3
        with pytest.raises(ValueError, match='immutable'):
            await Stream('events', adapter, {'partitions': 2}).publish(3)
    finally:
        await stream.close()
        await reopened.close()
        await adapter.cleanup()


async def test_same_partition_has_only_one_live_delivery() -> None:
    flow = create_flow()
    stream = flow.stream('ordered', {'partitions': 2})
    held: list[Message] = []
    gate = asyncio.Event()
    started = asyncio.Event()
    async def handler(message: Message) -> None:
        held.append(message)
        started.set()
        await gate.wait()
    try:
        first = await stream.publish(1, PublishOptions(partition=0))
        await stream.publish(2, PublishOptions(partition=0))
        consumer = stream.create_consumer('one', ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=2))
        await consumer.subscribe(handler)
        await asyncio.wait_for(started.wait(), 1)
        await asyncio.sleep(.02)
        assert [message.id for message in held] == [first]
    finally:
        gate.set()
        await flow.close()


@pytest.mark.parametrize(('key', 'expected'), [('', 2), ('tenant-α', 4), ('é', 13), ('e\u0301', 8), ('東京', 15), ('🧪', 13)])
def test_shared_typescript_utf8_vectors(key: str, expected: int) -> None:
    from flowfn.stream.partition import partition_for
    assert partition_for(17, 'unused', key, None) == expected
    assert partition_for(17, key, None, None) == expected
    assert partition_for(17, 'unused', key, 9) == 9


@pytest.mark.parametrize('count', [0, -1, True, 1.5, '2', 2147483648])
def test_invalid_partition_counts(count: object) -> None:
    from flowfn.stream.types import StreamOptions
    with pytest.raises(ValueError):
        StreamOptions.model_validate({'partitions': count})


async def test_invalid_routing_does_not_publish() -> None:
    adapter = MemoryAdapter()
    stream = Stream('invalid', adapter, {'partitions': 2})
    try:
        for options in [PublishOptions(partition=2), PublishOptions(key='\ud800'), PublishOptions(key='\udc00', partition=0)]:
            with pytest.raises(ValueError):
                await stream.publish(1, options)
        assert await adapter.get_stream_messages('invalid') == []
    finally:
        await stream.close()
        await adapter.cleanup()


async def test_manual_expiry_redelivers_and_stale_ack_cannot_release_successor() -> None:
    flow = create_flow()
    stream = flow.stream('expiry', {'partitions': 2})
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    async def handler(message: Message) -> None:
        deliveries.put_nowait(message)
    try:
        first = await stream.publish(1, PublishOptions(partition=0))
        second = await stream.publish(2, PublishOptions(partition=0))
        consumer = stream.create_consumer('one', ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=2, visibility_timeout=150))
        await consumer.subscribe(handler)
        old = await asyncio.wait_for(deliveries.get(), 1)
        replacement = await asyncio.wait_for(deliveries.get(), 1)
        assert old.id == replacement.id == first
        await old.ack()
        await asyncio.sleep(.02)
        assert deliveries.empty()
        await replacement.ack()
        successor = await asyncio.wait_for(deliveries.get(), 1)
        assert successor.id == second
        await successor.ack()
    finally:
        await flow.close()


async def test_trim_keeps_barrier_until_original_deadline_without_retaining_payload() -> None:
    from flowfn.stream.types import TrimStrategy
    flow = create_flow()
    stream = flow.stream('trim', {'partitions': 2})
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    async def handler(message: Message) -> None:
        deliveries.put_nowait(message)
    try:
        await stream.publish(1, PublishOptions(partition=0))
        consumer = stream.create_consumer('one', ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=2, visibility_timeout=150))
        await consumer.subscribe(handler)
        old = await asyncio.wait_for(deliveries.get(), 1)
        assert await stream.trim(TrimStrategy(max_length=0)) == 1
        assert await stream.get_messages("", "\uffff") == []
        successor_id = await stream.publish(2, PublishOptions(partition=0))
        await asyncio.sleep(.03)
        assert deliveries.empty()
        successor = await asyncio.wait_for(deliveries.get(), 1)
        assert successor.id == successor_id
        await old.ack()
        await successor.ack()
    finally:
        await flow.close()


async def test_unsubscribe_releases_owned_receipt_before_timeout() -> None:
    flow = create_flow()
    stream = flow.stream('unsubscribe', {'partitions': 1})
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    async def handler(message: Message) -> None:
        deliveries.put_nowait(message)
    try:
        identity = await stream.publish(1)
        options = ConsumerOptions(group_id='g', from_beginning=True, visibility_timeout=30000)
        first = stream.create_consumer('first', options)
        await first.subscribe(handler)
        old = await asyncio.wait_for(deliveries.get(), 1)
        await first.close()
        second = stream.create_consumer('second', options)
        await second.subscribe(handler)
        current = await asyncio.wait_for(deliveries.get(), 1)
        assert old.id == current.id == identity
        await old.ack()
        await current.ack()
    finally:
        await flow.close()


async def test_legacy_policy_cannot_change_after_trim_or_group_creation() -> None:
    from flowfn.stream.types import TrimStrategy
    adapter = MemoryAdapter()
    legacy = Stream('legacy', adapter)
    async def handler(message: Message) -> None:
        await message.ack()
    try:
        await legacy.publish(1)
        await legacy.trim(TrimStrategy(max_length=0))
        with pytest.raises(ValueError, match='immutable'):
            await Stream('legacy', adapter, {'partitions': 2}).publish(2)
        group_only = Stream('group-only', adapter)
        consumer = group_only.create_consumer('one', ConsumerOptions(group_id='g'))
        await consumer.subscribe(handler)
        with pytest.raises(ValueError, match='immutable'):
            await Stream('group-only', adapter, {'partitions': 2}).publish(2)
        await group_only.close()
    finally:
        await legacy.close()
        await adapter.cleanup()


async def test_independent_groups_partitions_and_sparse_progress() -> None:
    from flowfn.adapters.memory_stream import MemoryConsumerGroup
    adapter = MemoryAdapter()
    stream = Stream('sparse', adapter, {'partitions': 1_000_000})
    deliveries: asyncio.Queue[tuple[str, Message]] = asyncio.Queue()
    async def first_handler(message: Message) -> None:
        deliveries.put_nowait(('first', message))
    async def second_handler(message: Message) -> None:
        deliveries.put_nowait(('second', message))
    try:
        a = await stream.publish('a', PublishOptions(partition=999999))
        b = await stream.publish('b', PublishOptions(partition=1))
        for group, handler in [('first', first_handler), ('second', second_handler)]:
            consumer = stream.create_consumer(group, ConsumerOptions(group_id=group, from_beginning=True, max_in_flight=2))
            await consumer.subscribe(handler)
        results = [await asyncio.wait_for(deliveries.get(), 1) for _ in range(4)]
        assert {(group, message.id) for group, message in results} == {(group, identity) for group in ['first', 'second'] for identity in [a, b]}
        for state in adapter._groups.values():
            assert isinstance(state, MemoryConsumerGroup)
            assert len(state.cursors) == len(state.pending) == 2
        for _, message in results:
            await message.ack()
    finally:
        await stream.close()
        await adapter.cleanup()


async def test_active_handler_renews_until_completion_then_manual_deadline_expires() -> None:
    flow = create_flow()
    stream = flow.stream('renew', {'partitions': 1})
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    release = asyncio.Event()
    async def handler(message: Message) -> None:
        deliveries.put_nowait(message)
        await release.wait()
    try:
        identity = await stream.publish(1)
        consumer = stream.create_consumer('one', ConsumerOptions(group_id='g', from_beginning=True, max_in_flight=2, visibility_timeout=120))
        await consumer.subscribe(handler)
        original = await asyncio.wait_for(deliveries.get(), 1)
        await asyncio.sleep(.3)
        assert deliveries.empty()
        release.set()
        replacement = await asyncio.wait_for(deliveries.get(), 1)
        assert replacement.id == original.id == identity
        await replacement.ack()
    finally:
        release.set()
        await flow.close()


async def test_cached_handle_rejects_partition_policy_change() -> None:
    flow = create_flow()
    try:
        flow.stream('cached', {'partitions': 2})
        with pytest.raises(ValueError, match='Cached stream'):
            flow.stream('cached', {'partitions': 3})
    finally:
        await flow.close()


async def test_trimmed_renewal_failure_unsubscribe_releases_barrier() -> None:
    from flowfn.stream.types import TrimStrategy
    flow = create_flow()
    stream = flow.stream('trim-stop', {'partitions': 1})
    delivered = asyncio.Event()
    cancelled = asyncio.Event()
    async def held(message: Message) -> None:
        delivered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    results: asyncio.Queue[Message] = asyncio.Queue()
    async def replacement(message: Message) -> None:
        results.put_nowait(message)
    try:
        await stream.publish(1)
        first = stream.create_consumer('same-name', ConsumerOptions(group_id='g', from_beginning=True, visibility_timeout=900))
        await first.subscribe(held)
        await asyncio.wait_for(delivered.wait(), 1)
        await stream.trim(TrimStrategy(max_length=0))
        await asyncio.wait_for(cancelled.wait(), 1)
        # Failed renewal cancels the callback, but its barrier remains until
        # authorized unsubscribe or the original deadline, not renewal failure.
        identity = await stream.publish(2)
        await first.close()
        second = stream.create_consumer('same-name', ConsumerOptions(group_id='g', from_beginning=True))
        await second.subscribe(replacement)
        message = await asyncio.wait_for(results.get(), .4)
        assert message.id == identity
        await message.ack()
    finally:
        await flow.close()


async def test_from_now_cutoff_survives_sparse_new_partition_and_reopen() -> None:
    adapter = MemoryAdapter()
    stream = Stream('cutoff', adapter, {'partitions': 100})
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    async def handler(message: Message) -> None:
        deliveries.put_nowait(message)
    try:
        await stream.publish('old', PublishOptions(partition=99))
        first = stream.create_consumer('first', ConsumerOptions(group_id='g', max_in_flight=2))
        await first.subscribe(handler)
        new = await stream.publish('new', PublishOptions(partition=1))
        current = await asyncio.wait_for(deliveries.get(), 1)
        assert current.id == new
        await current.ack()
        await first.close()
        second = stream.create_consumer('second', ConsumerOptions(group_id='g', from_beginning=True))
        await second.subscribe(handler)
        later = await stream.publish('later', PublishOptions(partition=99))
        current = await asyncio.wait_for(deliveries.get(), 1)
        assert current.id == later
        await current.ack()
        await asyncio.sleep(.01)
        assert deliveries.empty()
    finally:
        await stream.close()
        await adapter.cleanup()
