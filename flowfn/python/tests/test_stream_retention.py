"""Stream retention uses storage age; durable legacy protection remains explicit."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any

import pytest

from flowfn.adapters.base import FlowAdapter
from flowfn.adapters.memory import MemoryAdapter
from flowfn.adapters.postgres import PostgresAdapter
from flowfn.adapters.redis import RedisAdapter
from flowfn.stream.stream import Stream
from flowfn.stream.types import ConsumerOptions, Message
from tests.assertions import require_value
from tests.native_support import NativeAdapters


async def seed_old(adapter: FlowAdapter,name: str) -> None:
    message=Message(id='old',stream=name,data='old',timestamp=1)
    if isinstance(adapter, RedisAdapter):
        await adapter.client.xadd(adapter._stream(name),{'payload':message.model_dump_json()},id='1-0')
    else:
        await adapter.publish(name,message)
        if isinstance(adapter, PostgresAdapter):
            pool=await adapter._database()
            await pool.execute("UPDATE flowfn_py_events SET created_at=clock_timestamp()-interval '1 day' WHERE namespace=$1 AND stream=$2",adapter.namespace,name)


async def assert_age_policy(adapter: FlowAdapter) -> None:
    await seed_old(adapter,'age')
    stream=Stream('age',adapter,{'retention':10000})
    assert (require_value(await stream.get_info())).length==0  # read enforces age without another publish
    await seed_old(adapter,'publish-age')
    stream=Stream('publish-age',adapter,{'retention':10000,'max_length':3})
    await stream.publish('fresh')
    assert [message.data for message in await adapter.get_stream_messages(stream.name)]==['fresh']
    await stream.close()
    await seed_old(adapter,'consumer-age')
    await adapter.publish('consumer-age',Message(id='new',stream='consumer-age',data='fresh',timestamp=int(time.time()*1000)))
    stream=Stream('consumer-age',adapter,{'retention':10000})
    received=asyncio.Event()
    values=[]
    async def receive(message: Message) -> None:
        values.append(message.data)
        await message.ack()
        received.set()
    consumer=stream.create_consumer('reader',ConsumerOptions(group_id='history',from_beginning=True,max_in_flight=1))
    await consumer.subscribe(receive)
    await asyncio.wait_for(received.wait(),5)
    assert set(values)=={'fresh'}  # Durable groups provide at-least-once delivery.
    await stream.close()


async def test_durable_stream_retention_option_uses_server_clock(adapters: NativeAdapters,monkeypatch: pytest.MonkeyPatch) -> None:
    a,b=adapters
    if isinstance(a, RedisAdapter):
        import flowfn.adapters.redis as module
        monkeypatch.setattr(module,'time',SimpleNamespace(time=lambda:time.time()+86400,monotonic=time.monotonic))
    await assert_age_policy(a)
    assert [message.data for message in await b.get_stream_messages('publish-age')]==['fresh']


async def test_memory_stream_age_policy() -> None:
    adapter=MemoryAdapter()
    try:
        await assert_age_policy(adapter)
    finally:
        await adapter.cleanup()


async def assert_pending_retention(adapter: FlowAdapter, *, rejects_stale_ack: bool=False) -> None:
    stream=Stream('protected',adapter,{'max_length':0,'retention':0})
    delivered=[]
    received=asyncio.Event()
    async def receive(message: Message) -> None:
        delivered.append(message)
        received.set()
    old=stream.create_consumer('old',ConsumerOptions(group_id='group',max_in_flight=1))
    await old.subscribe(receive)
    await stream.publish('pending')
    await stream.publish('unread')
    await asyncio.wait_for(received.wait(),5)
    assert (require_value(await stream.get_info())).length==2
    await old.close()
    # Durable delivery attempts explicitly reject stale ownership. In-memory
    # subscriptions retain their no-op behavior. Neither may release retention.
    if rejects_stale_ack:
        with pytest.raises(RuntimeError, match='ownership changed'):
            await delivered[0].ack()
    else:
        await delivered[0].ack()
    assert (require_value(await stream.get_info())).length==2
    received.clear()
    resumed=[]
    async def finish(message: Message) -> None:
        resumed.append(message.data)
        await message.ack()
        if set(resumed)=={'pending','unread'}:
            received.set()
    new=stream.create_consumer('new',ConsumerOptions(group_id='group',max_in_flight=1))
    await new.subscribe(finish)
    await asyncio.wait_for(received.wait(),5)
    assert set(resumed)=={'pending','unread'}
    assert (require_value(await stream.get_info())).length==0
    await stream.close()


async def test_durable_retention_preserves_unread_and_pending(adapters: NativeAdapters) -> None:
    await assert_pending_retention(adapters[0], rejects_stale_ack=True)


async def test_memory_retention_removes_unread_and_pending_payloads() -> None:
    adapter = MemoryAdapter()
    stream = Stream('bounded', adapter)
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    async def receive(message: Message) -> None:
        deliveries.put_nowait(message)
    try:
        await stream.publish('held')
        await stream.publish('unread')
        old = stream.create_consumer('old', ConsumerOptions(group_id='group', from_beginning=True, max_in_flight=1))
        await old.subscribe(receive)
        held = await asyncio.wait_for(deliveries.get(), 1)
        bounded = Stream('bounded', adapter, {'max_length': 0, 'retention': 0})
        assert (await bounded.get_info()).length == 0
        assert await adapter.get_stream_messages('bounded') == []
        await old.close()
        await held.ack()  # Stale settlement cannot recreate a deleted payload.
        new = bounded.create_consumer('new', ConsumerOptions(group_id='group', max_in_flight=1))
        await new.subscribe(receive)
        await asyncio.sleep(.02)
        assert deliveries.empty()
        assert adapter._groups[('bounded', 'group')].unacknowledged == set()
        assert adapter._groups[('bounded', 'group')].retry == []
        await bounded.close()
    finally:
        await stream.close()
        await adapter.cleanup()


@pytest.mark.parametrize('options',[{'retention':-1},{'retention':float('inf')},{'max_length':-1}])
async def test_invalid_retention_rejected_before_publishing(options: dict[str, Any]) -> None:
    adapter=MemoryAdapter()
    with pytest.raises(ValueError):
        Stream('invalid',adapter,options)
    assert await adapter.get_stream_messages('invalid')==[]
