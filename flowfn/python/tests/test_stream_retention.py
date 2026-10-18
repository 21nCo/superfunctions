"""Configured stream retention uses storage age and protects group deliveries."""
import asyncio
import time
from types import SimpleNamespace

import pytest

from flowfn.adapters.memory import MemoryAdapter
from flowfn.stream.stream import Stream
from flowfn.stream.types import ConsumerOptions, Message
from tests.test_durable_adapters import adapters  # noqa: F401


async def seed_old(adapter,name):
    message=Message(id='old',stream=name,data='old',timestamp=1)
    if hasattr(adapter,'client'):
        await adapter.client.xadd(adapter._stream(name),{'payload':message.model_dump_json()},id='1-0')
    else:
        await adapter.publish(name,message)
        if hasattr(adapter,'_database'):
            pool=await adapter._database()
            await pool.execute("UPDATE flowfn_py_events SET created_at=clock_timestamp()-interval '1 day' WHERE namespace=$1 AND stream=$2",adapter.namespace,name)


async def assert_age_policy(adapter):
    await seed_old(adapter,'age')
    stream=Stream('age',adapter,{'retention':10000})
    assert (await stream.get_info()).length==0  # read enforces age without another publish
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
    async def receive(message):
        values.append(message.data)
        await message.ack()
        received.set()
    consumer=stream.create_consumer('reader',ConsumerOptions(group_id='history',from_beginning=True,max_in_flight=1))
    await consumer.subscribe(receive)
    await asyncio.wait_for(received.wait(),5)
    assert set(values)=={'fresh'}  # Durable groups provide at-least-once delivery.
    await stream.close()


async def test_durable_stream_retention_option_uses_server_clock(adapters,monkeypatch):
    a,b=adapters
    if hasattr(a,'client'):
        import flowfn.adapters.redis as module
        monkeypatch.setattr(module,'time',SimpleNamespace(time=lambda:time.time()+86400))
    await assert_age_policy(a)
    assert [message.data for message in await b.get_stream_messages('publish-age')]==['fresh']


async def test_memory_stream_age_policy():
    adapter=MemoryAdapter()
    try:
        await assert_age_policy(adapter)
    finally:
        await adapter.cleanup()


async def assert_pending_retention(adapter):
    stream=Stream('protected',adapter,{'max_length':0,'retention':0})
    delivered=[]
    received=asyncio.Event()
    async def receive(message):
        delivered.append(message)
        received.set()
    old=stream.create_consumer('old',ConsumerOptions(group_id='group',max_in_flight=1))
    await old.subscribe(receive)
    await stream.publish('pending')
    await stream.publish('unread')
    await asyncio.wait_for(received.wait(),5)
    assert (await stream.get_info()).length==2
    await old.close()
    await delivered[0].ack()  # Disconnected delivery must not release pending retention.
    assert (await stream.get_info()).length==2
    received.clear()
    resumed=[]
    async def finish(message):
        resumed.append(message.data)
        await message.ack()
        if set(resumed)=={'pending','unread'}:
            received.set()
    new=stream.create_consumer('new',ConsumerOptions(group_id='group',max_in_flight=1))
    await new.subscribe(finish)
    await asyncio.wait_for(received.wait(),5)
    assert set(resumed)=={'pending','unread'}
    assert (await stream.get_info()).length==0
    await stream.close()


async def test_durable_retention_preserves_unread_and_pending(adapters):
    await assert_pending_retention(adapters[0])


async def test_memory_retention_preserves_unread_and_pending():
    adapter=MemoryAdapter()
    try:
        await assert_pending_retention(adapter)
    finally:
        await adapter.cleanup()


@pytest.mark.parametrize('options',[{'retention':-1},{'retention':float('inf')},{'max_length':-1}])
async def test_invalid_retention_rejected_before_publishing(options):
    adapter=MemoryAdapter()
    with pytest.raises(ValueError):
        Stream('invalid',adapter,options)
    assert await adapter.get_stream_messages('invalid')==[]
