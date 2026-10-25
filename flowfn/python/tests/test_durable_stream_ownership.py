"""Durable consumer claims keep distinct ownership within one subscription."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from flowfn.adapters.postgres import PostgresAdapter, PostgresSubscription
from flowfn.adapters.redis import RedisAdapter, RedisSubscription
from flowfn.stream.types import ConsumerOptions, Message
from tests.native_support import NativeAdapters


async def test_same_subscription_reclaim_fences_old_ack_and_renew(adapters: NativeAdapters) -> None:
    adapter,_=adapters
    if not isinstance(adapter, PostgresAdapter):
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


async def test_default_consumer_capacity_does_not_flood_claim_connections(adapters: NativeAdapters,monkeypatch: pytest.MonkeyPatch) -> None:
    adapter,_=adapters
    if not isinstance(adapter, PostgresAdapter):
        pytest.skip('PostgreSQL polling regression')
    from flowfn.adapters.postgres import PostgresSubscription
    original=PostgresSubscription._next
    active=peak=0
    async def tracked(self: PostgresSubscription,token: str) -> Any:
        nonlocal active,peak
        active+=1
        peak=max(peak,active)
        try:
            return await original(self,token)
        finally:
            active-=1
    monkeypatch.setattr(PostgresSubscription,'_next',tracked)
    received=asyncio.Event()
    async def receive(message: Message) -> None:
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
async def test_stream_handler_is_cancelled_when_renewal_loses_ownership(adapters: NativeAdapters,monkeypatch: pytest.MonkeyPatch,renewal: str) -> None:
    adapter,_=adapters
    if isinstance(adapter, PostgresAdapter):
        subscription_type: type[PostgresSubscription] | type[RedisSubscription] = PostgresSubscription
    else:
        subscription_type = RedisSubscription
    original_postgres = PostgresSubscription._owned
    original_redis = RedisSubscription._owned
    async def changed(self: PostgresSubscription | RedisSubscription,identity: int | str,owner: str,acknowledge: bool=False) -> bool:
        if acknowledge:
            if isinstance(self, PostgresSubscription):
                assert isinstance(identity, int)
                return await original_postgres(self,identity,owner,acknowledge=True)
            assert isinstance(identity, str)
            return await original_redis(self,identity,owner,acknowledge=True)
        if renewal=='hung':
            await asyncio.Event().wait()
        return False
    monkeypatch.setattr(subscription_type,'_owned',changed)
    entered,cancelled=asyncio.Event(),asyncio.Event()
    async def handle(message: Message) -> None:
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
        if isinstance(adapter, PostgresAdapter):
            pool=await adapter._database()
            assert await pool.fetchval('SELECT count(*) FROM flowfn_py_pending WHERE namespace=$1',adapter.namespace)==1
        else:
            assert (await adapter.client.xpending(adapter._stream('cancel'),'group'))['pending']==1
    finally:
        await subscription.unsubscribe()


async def test_redis_same_subscription_reclaim_fences_old_ack_and_renew(adapters: NativeAdapters) -> None:
    adapter,_=adapters
    if not isinstance(adapter, RedisAdapter):
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
    execute: Callable[..., Awaitable[Any]] = adapter.client.execute_command
    assert await execute('HLEN',subscription._owners_key)==0


async def test_ack_reply_after_local_cancellation_is_settled_safely(adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch) -> None:
    adapter, _ = adapters
    adapter.reclaim_after_ms = 5000
    if isinstance(adapter, PostgresAdapter):
        subscription_type: type[PostgresSubscription] | type[RedisSubscription] = PostgresSubscription
    else:
        subscription_type = RedisSubscription
    original_postgres = PostgresSubscription._owned
    original_redis = RedisSubscription._owned
    committed = asyncio.Event()
    release = asyncio.Event()
    async def delayed(self: PostgresSubscription | RedisSubscription, identity: int | str, owner: str, acknowledge: bool=False) -> bool:
        if isinstance(self, PostgresSubscription):
            assert isinstance(identity, int)
            result = await original_postgres(self, identity, owner, acknowledge=acknowledge)
        else:
            assert isinstance(identity, str)
            result = await original_redis(self, identity, owner, acknowledge=acknowledge)
        if acknowledge:
            committed.set()
            await release.wait()
        return result
    monkeypatch.setattr(subscription_type, '_owned', delayed)
    received = asyncio.Event()
    messages = []
    async def handler(message: Message) -> None:
        messages.append(message)
        received.set()
    subscription = await adapter.consume('ack-race', 'g', 'reader', handler, ConsumerOptions(group_id='g', max_in_flight=1))
    await adapter.publish('ack-race', Message(id='one', stream='ack-race', data={}, timestamp=0))
    try:
        await asyncio.wait_for(received.wait(), 5)
        ack = asyncio.create_task(messages[0].ack())
        await asyncio.wait_for(committed.wait(), 5)
        await subscription.unsubscribe()
        release.set()
        await ack
        with pytest.raises(RuntimeError, match='ownership changed'):
            await messages[0].ack()
    finally:
        release.set()
        await subscription.unsubscribe()
