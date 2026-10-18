"""Durable consumer claims keep distinct ownership within one subscription."""
import asyncio

import pytest

from flowfn.stream.types import ConsumerOptions, Message
from tests.test_durable_adapters import adapters  # noqa: F401


async def test_same_subscription_reclaim_fences_old_ack_and_renew(adapters):
    adapter,_=adapters
    if not hasattr(adapter,'_database'):
        pytest.skip('PostgreSQL ownership regression')
    from flowfn.adapters.postgres import PostgresSubscription
    pool=await adapter._database()
    await adapter.publish('owned',Message(id='one',stream='owned',data={},timestamp=0))
    await pool.execute('INSERT INTO flowfn_py_groups VALUES($1,$2,$3,0)',adapter.namespace,'owned','group')
    subscription=PostgresSubscription(adapter,'owned',None,group='group',consumer='same')
    first=await subscription._next('attempt-one')
    await pool.execute("UPDATE flowfn_py_pending SET expires_at=clock_timestamp()-interval '1 second' WHERE namespace=$1",adapter.namespace)
    assert not await subscription._owned(first['id'],'attempt-one')
    assert not await subscription._owned(first['id'],'attempt-one',acknowledge=True)
    second=await subscription._next('attempt-two')
    assert second['id']==first['id']
    assert not await subscription._owned(first['id'],'attempt-one')
    assert not await subscription._owned(first['id'],'attempt-one',acknowledge=True)
    assert await subscription._owned(second['id'],'attempt-two')
    assert await subscription._owned(second['id'],'attempt-two',acknowledge=True)


async def test_default_consumer_capacity_does_not_flood_claim_connections(adapters,monkeypatch):
    adapter,_=adapters
    if not hasattr(adapter,'_database'):
        pytest.skip('PostgreSQL polling regression')
    from flowfn.adapters.postgres import PostgresSubscription
    original=PostgresSubscription._next
    active=peak=0
    async def tracked(self,token):
        nonlocal active,peak
        active+=1
        peak=max(peak,active)
        try:
            return await original(self,token)
        finally:
            active-=1
    monkeypatch.setattr(PostgresSubscription,'_next',tracked)
    received=asyncio.Event()
    async def receive(message):
        await message.ack()
        received.set()
    subscription=await adapter.consume('capacity','group','reader',receive,ConsumerOptions(group_id='group'))
    await adapter.publish('capacity',Message(id='one',stream='capacity',data={},timestamp=0))
    try:
        await asyncio.wait_for(received.wait(),5)
        assert peak==1
    finally:
        await subscription.unsubscribe()


@pytest.mark.parametrize('renewal',['lost','hung'])
async def test_stream_handler_is_cancelled_when_renewal_loses_ownership(adapters,monkeypatch,renewal):
    adapter,_=adapters
    if hasattr(adapter,'_database'):
        from flowfn.adapters.postgres import PostgresSubscription as Subscription
    else:
        from flowfn.adapters.redis import RedisSubscription as Subscription
    original=Subscription._owned
    async def changed(self,identity,owner,acknowledge=False):
        if acknowledge:
            return await original(self,identity,owner,acknowledge=True)
        if renewal=='hung':
            await asyncio.Event().wait()
        return False
    monkeypatch.setattr(Subscription,'_owned',changed)
    entered,cancelled=asyncio.Event(),asyncio.Event()
    async def handle(message):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
    subscription=await adapter.consume('cancel','group','reader',handle,ConsumerOptions(group_id='group',max_in_flight=1))
    await adapter.publish('cancel',Message(id='one',stream='cancel',data={},timestamp=0))
    try:
        await asyncio.wait_for(entered.wait(),5)
        await asyncio.wait_for(cancelled.wait(),3)
        if hasattr(adapter,'_database'):
            pool=await adapter._database()
            assert await pool.fetchval('SELECT count(*) FROM flowfn_py_pending WHERE namespace=$1',adapter.namespace)==1
        else:
            assert (await adapter.client.xpending(adapter._stream('cancel'),'group'))['pending']==1
    finally:
        await subscription.unsubscribe()


async def test_redis_same_subscription_reclaim_fences_old_ack_and_renew(adapters):
    adapter,_=adapters
    if not hasattr(adapter,'client'):
        pytest.skip('Redis ownership regression')
    from flowfn.adapters.redis import RedisSubscription
    key=adapter._stream('owned')
    await adapter.client.xgroup_create(key,'group',id='0-0',mkstream=True)
    await adapter.publish('owned',Message(id='one',stream='owned',data={},timestamp=0))
    subscription=RedisSubscription(adapter,'owned',None,group='group',consumer='same')
    first=(await subscription._next('attempt-one'))[0][0]
    await adapter.client.xclaim(key,'group',subscription.consumer,0,[first],idle=2000,justid=True)
    assert not await subscription._owned(first,'attempt-one')
    assert not await subscription._owned(first,'attempt-one',acknowledge=True)
    second=(await subscription._next('attempt-two'))[0][0]
    assert first==second
    assert not await subscription._owned(first,'attempt-one')
    assert not await subscription._owned(first,'attempt-one',acknowledge=True)
    assert await subscription._owned(second,'attempt-two')
    assert await subscription._owned(second,'attempt-two',acknowledge=True)
    assert await adapter.client.hlen(subscription._owners_key)==0
