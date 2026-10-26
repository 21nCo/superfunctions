"""Owned PostgreSQL schema upgrade, partition receipts and process recovery."""
from __future__ import annotations

import asyncio
import json
import shutil
import socket
import subprocess
import sys
import uuid
from collections.abc import AsyncIterator, Iterator

import asyncpg  # type: ignore[import-untyped]
import pytest

from flowfn.adapters.postgres import _SCHEMA, PostgresAdapter
from flowfn.stream.partition import partition_for
from flowfn.stream.stream import Stream
from flowfn.stream.types import ConsumerOptions, Message, TrimStrategy


@pytest.fixture(scope='module')
def pg_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    initdb, pg_ctl = shutil.which('initdb'), shutil.which('pg_ctl')
    if not initdb or not pg_ctl:
        pytest.skip('Native PostgreSQL required')
    directory = tmp_path_factory.mktemp('partition-pg')
    data = directory / 'data'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    subprocess.run([initdb, '-D', str(data), '-U', 'postgres', '-A', 'trust', '--no-locale'], check=True, capture_output=True, timeout=30)
    started = False
    try:
        subprocess.run([pg_ctl, '-D', str(data), '-l', str(directory/'server.log'), '-o', f"-h 127.0.0.1 -p {port} -k ''", '-w', 'start'], check=True, capture_output=True, timeout=30)
        started = True
        yield f'postgresql://postgres@127.0.0.1:{port}/postgres'
    except subprocess.CalledProcessError:
        if (directory/'server.log').exists():
            print((directory/'server.log').read_text())
        raise
    finally:
        if started or (data/'postmaster.pid').exists():
            subprocess.run([pg_ctl, '-D', str(data), '-m', 'immediate', '-w', 'stop'], check=True, capture_output=True, timeout=15)
        shutil.rmtree(directory)
        assert not directory.exists()


@pytest.fixture
async def pair(pg_url: str) -> AsyncIterator[tuple[PostgresAdapter, PostgresAdapter]]:
    namespace = 'native:/分%' + uuid.uuid4().hex
    a, b = (PostgresAdapter(pg_url, namespace=namespace, reclaim_after_ms=100) for _ in range(2))
    try:
        yield a, b
    finally:
        await a.cleanup()
        await b.cleanup()


def options() -> ConsumerOptions:
    return ConsumerOptions(group_id='group', from_beginning=True, auto_commit=False, visibility_timeout=200, max_in_flight=1)


async def test_policy_routing_snapshot_and_legacy_fence(pair: tuple[PostgresAdapter, PostgresAdapter]) -> None:
    a, b = pair
    await a.configure_stream('orders', 3)
    stream = Stream('orders', a, {'partitions': 3})
    value = {'nested': [1]}
    await stream.publish(value)
    value['nested'].append(2)
    await b.publish('orders', Message(id='unicode', stream='orders', data=3, timestamp=0, key='分'))
    rows = await b.get_stream_messages('orders')
    assert rows[0].data == {'nested': [1]}
    assert rows[1].partition == partition_for(3, 'unicode', '分', None)
    assert (await b.get_stream_info('orders')).partitions == 3
    with pytest.raises(ValueError, match='immutable'):
        await b.configure_stream('orders', 4)
    with pytest.raises(ValueError, match='outside'):
        await b.publish('orders', Message(id='bad', stream='orders', data=1, timestamp=0, partition=3))
    assert len(await a.get_stream_messages('orders')) == 2
    await a.publish('legacy', Message(id='old', stream='legacy', data=0, timestamp=0))
    with pytest.raises(ValueError, match='immutable'):
        await b.configure_stream('legacy', 2)
    results = await asyncio.gather(a.configure_stream('race', 2), b.configure_stream('race', 3), return_exceptions=True)
    assert sum(isinstance(item, ValueError) for item in results) == 1
    assert await a.configure_stream('race') in (2, 3)


async def group(adapter: PostgresAdapter, name: str = 'orders', beginning: bool = True) -> None:
    sub = await adapter.consume(name, 'group', 'setup', lambda message: asyncio.sleep(0), ConsumerOptions(group_id='group', from_beginning=beginning,max_in_flight=1))
    await sub.unsubscribe()


async def publish(adapter: PostgresAdapter, identity: str, partition: int, stream: str = 'orders') -> None:
    await adapter.publish(stream, Message(id=identity, stream=stream, data=identity, timestamp=0, partition=partition))


async def test_independent_receipts_requeue_stale_and_cutoff(pair: tuple[PostgresAdapter, PostgresAdapter]) -> None:
    a, b = pair
    await a.configure_stream('orders', 2)
    for identity, partition in [('first', 0), ('second', 0), ('other', 1)]:
        await publish(a, identity, partition)
    await group(a)
    first = await a._partitions.claim('orders', 'group', 1000, 'one')
    other = await b._partitions.claim('orders', 'group', 1000, 'two')
    assert json.loads(first['payload'])['id'] == 'first'
    assert json.loads(other['payload'])['id'] == 'other'
    assert await b._partitions.claim('orders', 'group', 1000, 'blocked') is None
    assert await a._partitions.settle('orders', 'group', first['id'], 'one', True)
    retry = await b._partitions.claim('orders', 'group', 1000, 'replacement')
    assert retry['id'] == first['id']
    assert not await a._partitions.settle('orders', 'group', first['id'], 'one', False)
    assert await b._partitions.settle('orders', 'group', retry['id'], 'replacement', False)
    successor = await b._partitions.claim('orders', 'group', 1000, 'next')
    assert json.loads(successor['payload'])['id'] == 'second'
    await a.configure_stream('tail', 2)
    await publish(a, 'before', 0, 'tail')
    await group(a, 'tail', False)
    assert await b._partitions.claim('tail', 'group', 1000, 'none') is None
    await publish(a, 'after', 1, 'tail')
    assert json.loads((await b._partitions.claim('tail', 'group', 1000, 'after'))['payload'])['id'] == 'after'


async def test_manual_expiry_and_shutdown_release(pair: tuple[PostgresAdapter, PostgresAdapter]) -> None:
    a, b = pair
    await a.configure_stream('orders', 1)
    await publish(a, 'first', 0)
    deliveries: asyncio.Queue[Message] = asyncio.Queue()
    async def returned(message: Message) -> None:
        deliveries.put_nowait(message)
    one = await a.consume('orders', 'group', 'first', returned, options())
    held = await asyncio.wait_for(deliveries.get(), 2)
    two = await b.consume('orders', 'group', 'second', returned, options())
    retry = await asyncio.wait_for(deliveries.get(), 2)
    assert retry.id == held.id
    with pytest.raises(RuntimeError, match='ownership changed'):
        await held.ack()
    await retry.ack()
    await one.unsubscribe()
    await two.unsubscribe()
    assert (await b.get_stream_info('orders')).lag == 0


async def test_retention_preserves_barrier_until_expiry_and_cancels(pair: tuple[PostgresAdapter, PostgresAdapter]) -> None:
    a, b = pair
    await a.configure_stream('orders', 1)
    await publish(a, 'held', 0)
    entered, cancelled, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def hold(message: Message) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue
    one = await a.consume('orders', 'group', 'held', hold, options())
    try:
        await asyncio.wait_for(entered.wait(), 2)
        assert await b.trim_stream('orders', TrimStrategy(max_length=0)) == 1
        await publish(b, 'next', 0)
        await asyncio.wait_for(cancelled.wait(), 2)
        assert await b._partitions.claim('orders', 'group', 200, 'too-early') is None
        await asyncio.sleep(.22)
        successor = await b._partitions.claim('orders', 'group', 1000, 'successor')
        assert json.loads(successor['payload'])['id'] == 'next'
    finally:
        release.set()
        await one.unsubscribe()
    assert not await a._partitions.settle('orders', 'group', successor['id'], 'wrong', False)
    assert await b._partitions.settle('orders', 'group', successor['id'], 'successor', False)


async def test_explicit_v1_upgrade_rolls_back_then_preserves_history(pg_url: str) -> None:
    admin = await asyncpg.connect(pg_url)
    database = 'migration_' + uuid.uuid4().hex
    await admin.execute('CREATE DATABASE ' + database)
    url = pg_url.rsplit('/', 1)[0] + '/' + database
    old = await asyncpg.connect(url)
    adapter = PostgresAdapter(url, namespace='migration')
    try:
        await old.execute(_SCHEMA)
        await old.execute("INSERT INTO flowfn_py_events(namespace,stream,payload) VALUES('migration','old',$1)", Message(id='old',stream='old',data=1,timestamp=0).model_dump_json())
        await old.execute("CREATE FUNCTION fail_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version=2 THEN RAISE EXCEPTION 'fixture migration failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_v2 BEFORE INSERT ON flowfn_py_meta FOR EACH ROW EXECUTE FUNCTION fail_v2()")
        with pytest.raises(RuntimeError, match='explicit'):
            await adapter.configure_stream('new', 2)
        with pytest.raises(Exception, match='fixture migration failure'):
            await adapter.migrate_stream_schema()
        assert await old.fetchval('SELECT max(version) FROM flowfn_py_meta') == 1
        assert await old.fetchval("SELECT to_regclass('flowfn_py_partition_barriers')") is None
        await old.execute('DROP TRIGGER fail_v2 ON flowfn_py_meta; DROP FUNCTION fail_v2()')
        await adapter.migrate_stream_schema()
        await adapter.migrate_stream_schema()
        assert await old.fetchval('SELECT max(version) FROM flowfn_py_meta') == 2
        assert [m.id for m in await adapter.get_stream_messages('old')] == ['old']
        with pytest.raises(ValueError, match='immutable'):
            await adapter.configure_stream('old', 2)
        await adapter.configure_stream('new', 2)
    finally:
        await adapter.cleanup()
        await old.close()
        await admin.execute('DROP DATABASE ' + database)
        await admin.close()


async def test_killed_owner_recovers_same_receipt_before_successor(pair: tuple[PostgresAdapter, PostgresAdapter], pg_url: str) -> None:
    a, b = pair
    await a.configure_stream('orders', 1)
    await publish(a, 'first', 0)
    await publish(a, 'second', 0)
    await group(a)
    code = '''import asyncio,json,sys
from flowfn.adapters.postgres import PostgresAdapter
async def main():
 a=PostgresAdapter(sys.argv[1],namespace=sys.argv[2])
 row=await a._partitions.claim('orders','group',200,'killed')
 print(json.dumps({'id':row['id']}),flush=True)
 await asyncio.Event().wait()
asyncio.run(main())'''
    child = await asyncio.create_subprocess_exec(sys.executable, '-c', code, pg_url, a.namespace, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        assert child.stdout is not None
        receipt = json.loads(await asyncio.wait_for(child.stdout.readline(), 3))
        child.kill()
        await asyncio.wait_for(child.wait(), 3)
        await asyncio.sleep(.23)
        recovered = await b._partitions.claim('orders', 'group', 1000, 'reopened')
        assert recovered['id'] == receipt['id']
        assert not await a._partitions.renew('orders', 'group', receipt['id'], 'killed', 1000)
        assert await b._partitions.settle('orders', 'group', receipt['id'], 'reopened', False)
        assert json.loads((await b._partitions.claim('orders', 'group', 1000, 'next'))['payload'])['id'] == 'second'
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()


async def test_cleanup_fences_admission_joins_and_releases_receipt(pair: tuple[PostgresAdapter, PostgresAdapter]) -> None:
    a, b = pair
    await a.configure_stream('orders', 1)
    await publish(a, 'first', 0)
    entered, cancelling, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def hold(message: Message) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelling.set()
            await release.wait()
    await a.consume('orders', 'group', 'held', hold, ConsumerOptions(group_id='group',from_beginning=True,visibility_timeout=5000,max_in_flight=1))
    await asyncio.wait_for(entered.wait(), 2)
    closing = asyncio.create_task(a.cleanup())
    await asyncio.wait_for(cancelling.wait(), 2)
    concurrent = asyncio.create_task(a.cleanup())
    try:
        closing.cancel()
        await asyncio.sleep(0)
        closing.cancel()
        await asyncio.sleep(0)
        assert not closing.done()
        with pytest.raises(RuntimeError, match='closed'):
            await a.configure_stream('new', 1)
        with pytest.raises(RuntimeError, match='closed'):
            await publish(a, 'forbidden', 0)
        with pytest.raises(RuntimeError, match='closed'):
            await a.consume('orders','group','forbidden',hold,options())
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(closing, 2)
        await asyncio.wait_for(concurrent, 2)
    replacement = await b._partitions.claim('orders','group',1000,'immediate')
    assert json.loads(replacement['payload'])['id'] == 'first'
    await a.cleanup()


async def test_legacy_payload_retention_and_fractional_server_age(pair: tuple[PostgresAdapter, PostgresAdapter]) -> None:
    a, b = pair
    pool = await a._database()
    await a.publish('legacy', Message(id='old',stream='legacy',data=1,timestamp=0))
    await pool.execute("UPDATE flowfn_py_events SET created_at=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND stream='legacy'", a.namespace)
    await a.publish('legacy', Message(id='fresh',stream='legacy',data=2,timestamp=0))
    assert await b.trim_stream('legacy',TrimStrategy(max_age_seconds=.5)) == 1
    entered, cancelled = asyncio.Event(), asyncio.Event()
    captured: list[Message] = []
    async def hold(message: Message) -> None:
        captured.append(message)
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    subscription = await a.consume('legacy','group','held',hold,ConsumerOptions(group_id='group',from_beginning=True,max_in_flight=1))
    await asyncio.wait_for(entered.wait(),2)
    await a.publish('legacy', Message(id='unread',stream='legacy',data=3,timestamp=0))
    assert await b.trim_stream('legacy',TrimStrategy(max_length=0)) == 2
    await asyncio.wait_for(cancelled.wait(),2)
    await subscription.unsubscribe()
    with pytest.raises(RuntimeError,match='ownership changed'):
        await captured[0].ack()
    assert await b.get_stream_messages('legacy') == []
    assert (await b.get_stream_info('legacy')).lag == 0


async def test_cleanup_joins_held_migration_pool(pg_url: str) -> None:
    admin = await asyncpg.connect(pg_url)
    database = 'held_migration_' + uuid.uuid4().hex
    await admin.execute('CREATE DATABASE ' + database)
    url = pg_url.rsplit('/',1)[0] + '/' + database
    old = await asyncpg.connect(url)
    adapter = PostgresAdapter(url)
    migrating: asyncio.Task[None] | None = None
    closing: asyncio.Task[None] | None = None
    try:
        await old.execute(_SCHEMA)
        await old.execute('SELECT pg_advisory_lock(490182735)')
        migrating = asyncio.create_task(adapter.migrate_stream_schema())
        for _ in range(100):
            if await old.fetchval("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted"):
                break
            await asyncio.sleep(.01)
        else:
            raise AssertionError('Migration did not reach owned lock wait')
        closing = asyncio.create_task(adapter.cleanup())
        await asyncio.sleep(.02)
        assert not closing.done()
        with pytest.raises(RuntimeError,match='closed'):
            await adapter.configure_stream('no',1)
        await old.execute('SELECT pg_advisory_unlock(490182735)')
        await asyncio.wait_for(migrating,2)
        await asyncio.wait_for(closing,2)
        assert await old.fetchval('SELECT max(version) FROM flowfn_py_meta') == 2
        assert await old.fetchval('SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()') == 0
    finally:
        await old.execute('SELECT pg_advisory_unlock_all()')
        if migrating is not None:
            await migrating
        if closing is not None:
            await closing
        await adapter.cleanup()
        await old.close()
        await admin.execute('DROP DATABASE ' + database)
        await admin.close()
