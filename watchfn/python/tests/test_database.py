import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import BigInteger, Column, MetaData, String, Table, Text, create_engine, select, func
from superfunctions_sqlalchemy import create_adapter
from watchfn import WatchFn, Event, get_watchfn_schema


def migrate(engine):
    schema = get_watchfn_schema()
    metadata = MetaData()
    table = Table(schema.name, metadata, *[Column(field.name, Text if field.type == 'text' else BigInteger if field.type == 'bigint' else String, primary_key=field.primary_key, nullable=field.nullable, unique=field.unique) for field in schema.fields])
    metadata.create_all(engine)
    return table


def start(adapter):
    watch = WatchFn('database', storage='database', database=adapter, auth={'apiKey': 'secret'})
    watch.system_metrics.start = lambda: None
    watch.process_metrics.start = lambda: None
    watch.start()
    return watch


def http(watch, framework):
    if framework == 'fastapi':
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from watchfn.adapters.fastapi import create_fastapi_router
        app = FastAPI(); app.include_router(create_fastapi_router(watch))
        client = TestClient(app)
    else:
        from flask import Flask
        from watchfn.adapters.flask import create_flask_blueprint
        app = Flask(__name__); app.register_blueprint(create_flask_blueprint(watch))
        client = app.test_client()
    def post(path, data):
        return client.post('/watch/' + path, json=data, headers={'x-api-key': 'secret'})
    return post, lambda response: response.json() if framework == 'fastapi' else response.get_json()


@pytest.mark.parametrize('framework', ['fastapi', 'flask'])
def test_sqlite_http_sync_track_restart_and_json(tmp_path, framework):
    path = tmp_path / 'events.sqlite'
    engine = create_engine('sqlite:///' + str(path))
    table = migrate(engine)
    watch = start(create_adapter(engine))
    try:
        post, body = http(watch, framework)
        response = post('ingest', [{'name': 'http', 'properties': {'array': [True, None, '✓']}}])
        assert response.status_code == 202
        with engine.connect() as connection:
            row = connection.execute(select(table)).mappings().one()
            assert json.loads(row['payload'])['properties']['array'] == [True, None, '✓']
            assert row['projectionVersion'] == 0
        watch.track('sync')
        response = post('query', {})
        assert response.status_code == 200
        assert {value['name'] for value in body(response)['results']} == {'http', 'sync'}
        assert len(watch.query()) == 2
    finally:
        watch.stop(); engine.dispose()
    engine = create_engine('sqlite:///' + str(path))
    watch = start(create_adapter(engine))
    try:
        post, body = http(watch, framework)
        assert [value['name'] for value in body(post('query', {'metric': 'http'}))['results']] == ['http']
        watch.stop()
        assert watch.storage._thread is None
        watch.start()
        assert len(watch.query()) == 2
    finally:
        watch.stop(); engine.dispose()


def test_rollback_and_ambiguous_commit_retry(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'events.sqlite'))
    table = migrate(engine)
    adapter = create_adapter(engine)
    original = adapter.transaction
    watch = start(adapter)
    try:
        async def rollback(callback):
            async def fail(transaction):
                original_create = transaction.create
                calls = 0
                async def create(params):
                    nonlocal calls
                    calls += 1
                    if calls == 2:
                        raise RuntimeError('private SQL URL')
                    return await original_create(params)
                transaction.create = create
                return await callback(transaction)
            return await original(fail)
        adapter.transaction = rollback
        post, _ = http(watch, 'fastapi')
        assert post('ingest', [{'name': 'one'}, {'name': 'two'}]).status_code == 503
        with engine.connect() as connection:
            assert connection.scalar(select(func.count()).select_from(table)) == 0
        lost = True
        async def ambiguous(callback):
            nonlocal lost
            result = await original(callback)
            if lost:
                lost = False
                raise RuntimeError('ack lost after commit')
            return result
        adapter.transaction = ambiguous
        watch.track('retry')
        with pytest.raises(RuntimeError, match='ack lost'):
            watch.query()
        assert len(watch.query()) == 1
        assert watch.batcher._pending == __import__('collections').deque()
    finally:
        adapter.transaction = original
        watch.stop(); engine.dispose()


@pytest.mark.asyncio
async def test_async_loop_ownership_and_cancellation_drain(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'events.sqlite'))
    migrate(engine)
    adapter = create_adapter(engine)
    original = adapter.transaction
    entered, release = threading.Event(), threading.Event()
    loops = set()
    async def held(callback):
        loops.add(id(asyncio.get_running_loop()))
        entered.set()
        while not release.is_set():
            await asyncio.sleep(0.005)
        return await original(callback)
    adapter.transaction = held
    watch = start(adapter)
    try:
        pending = asyncio.create_task(watch.storage.add_batch_async([Event(type='track', name='held')]))
        assert await asyncio.to_thread(entered.wait, 5)
        assert not pending.done()
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        stopping = asyncio.create_task(asyncio.to_thread(watch.stop))
        await asyncio.sleep(0.02)
        assert not stopping.done()
        release.set()
        await asyncio.wait_for(stopping, 5)
        assert watch.storage._thread is None
        assert len(loops) == 1
    finally:
        release.set()
        watch.stop(); engine.dispose()


def test_scan_limits_and_invalid_storage_configuration(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'events.sqlite'))
    migrate(engine)
    watch = start(create_adapter(engine))
    try:
        watch.storage.add_batch([Event(type='track', name='one'), Event(type='track', name='two')])
        watch.storage.SCAN_LIMIT = 1
        post, _ = http(watch, 'fastapi')
        assert post('query', {'limit': 1}).status_code == 503
    finally:
        watch.stop(); engine.dispose()
    with pytest.raises(ValueError):
        WatchFn('missing', storage='database')
    with pytest.raises(ValueError):
        WatchFn('invalid', storage='databse')
    with pytest.raises(ValueError):
        get_watchfn_schema('bad;table')


def test_concurrent_stop_and_missing_migration_failure(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'missing.sqlite'))
    watch = start(create_adapter(engine))
    try:
        post, _ = http(watch, 'fastapi')
        assert post('ingest', {'name': 'missing-table'}).status_code == 503
        assert post('query', {}).status_code == 503
        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(lambda _: watch.stop(), range(2)))
        assert watch.storage._thread is None
    finally:
        watch.stop(); engine.dispose()


def test_http_waits_for_database_commit(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'events.sqlite'))
    table = migrate(engine)
    adapter = create_adapter(engine)
    original = adapter.transaction
    entered, release = threading.Event(), threading.Event()
    async def held(callback):
        entered.set()
        while not release.is_set():
            await asyncio.sleep(0.005)
        return await original(callback)
    adapter.transaction = held
    watch = start(adapter)
    try:
        post, _ = http(watch, 'fastapi')
        with ThreadPoolExecutor(max_workers=1) as executor:
            result = executor.submit(post, 'ingest', {'name': 'committed'})
            try:
                assert entered.wait(5)
                assert not result.done()
                with engine.connect() as connection:
                    assert connection.scalar(select(func.count()).select_from(table)) == 0
            finally:
                release.set()
            assert result.result(timeout=5).status_code == 202
        with engine.connect() as connection:
            assert connection.scalar(select(func.count()).select_from(table)) == 1
    finally:
        release.set(); watch.stop(); engine.dispose()


def test_independent_instances_and_http_at_least_once(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'events.sqlite'))
    table = migrate(engine)
    one, two = start(create_adapter(engine)), start(create_adapter(engine))
    try:
        def write(watch):
            watch.storage.add_batch([Event(type='track', name='instance') for _ in range(10)])
        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(write, [one, two]))
        post, _ = http(one, 'fastapi')
        assert post('ingest', {'name': 'same-request'}).status_code == 202
        assert post('ingest', {'name': 'same-request'}).status_code == 202
        assert len(two.query()) == 22
        with engine.connect() as connection:
            assert connection.scalar(select(func.count()).select_from(table)) == 22
    finally:
        one.stop(); two.stop(); engine.dispose()


@pytest.mark.parametrize('framework', ['fastapi', 'flask'])
def test_structured_query_after_reopen_and_complete_scan(tmp_path, framework):
    from pathlib import Path
    vectors = json.loads((Path(__file__).parent / 'fixtures/query-golden.json').read_text())
    engine = create_engine('sqlite:///' + str(tmp_path / 'queries.sqlite'))
    migrate(engine)
    watch = start(create_adapter(engine))
    try:
        watch.storage.add_batch([Event.model_validate(value) for value in vectors['events']])
    finally:
        watch.stop(); engine.dispose()
    engine = create_engine('sqlite:///' + str(tmp_path / 'queries.sqlite'))
    watch = start(create_adapter(engine))
    try:
        post, body = http(watch, framework)
        vector = next(value for value in vectors['cases'] if value['name'] == 'numeric aggregations ignore strings and null')
        response = post('query', vector['query'])
        assert response.status_code == 200
        assert body(response)['results'] == vector['expected']
        grouped = {'metric':'request','timeRange':[1767916800000,1767916860000], 'groupBy':'endpoint', 'aggregations':{'count':{'operation':'count'},'p95':{'operation':'percentile','field':'duration','percentile':95}},'orderBy':{'field':'count','direction':'desc'},'limit':1}
        assert body(post('query', grouped))['results'] == [{'endpoint':'/a','count':2,'p95':9.5}]
        watch.storage.SCAN_LIMIT = 2
        assert post('query', grouped).status_code == 503  # Limit1 never bypasses the scan cap.
    finally:
        watch.stop(); engine.dispose()


@pytest.mark.parametrize('framework', ['fastapi', 'flask'])
def test_rates_calendar_scalar_fallback_after_reopen(tmp_path, framework):
    from datetime import datetime, timezone
    engine = create_engine('sqlite:///' + str(tmp_path / 'scalar.sqlite'))
    migrate(engine)
    watch = start(create_adapter(engine))
    try:
        events = [Event(type='track', name='request', properties={'endpoint':'/api','duration':value}) for value in (10,30)]
        events += [Event(type='track',name='error',properties={'endpoint':'/api'}), Event(type='track', name='request.duration', properties={'value':999}, timestamp=datetime(2000,1,1,tzinfo=timezone.utc))]
        events += [Event(type='track',name='latency',properties={'duration':value}) for value in (4,8)]
        watch.storage.add_batch(events)
    finally:
        watch.stop(); engine.dispose()
    engine = create_engine('sqlite:///' + str(tmp_path / 'scalar.sqlite'))
    watch = start(create_adapter(engine))
    try:
        post, body = http(watch, framework)
        options = {'metric':'request','timeRange':'today','groupBy':'endpoint','aggregations':{'count':{'operation':'count'},'rate':{'operation':'rate','numerator':{'metric':'error'},'denominator':{'metric':'request'}}}}
        assert body(post('query', options))['results'] == [{'endpoint':'/api','count':2,'rate':0.5}]
        assert watch.aggregate({'metric':'latency.duration','aggregation':'avg'}) == [{'value':6}]
        assert watch.aggregate({'metric':'latency.duration','aggregation':'p50'}) == [{'value':6}]
        assert watch.aggregate({'metric':'request.duration','aggregation':'avg','timeRange':'today'}) == [{'value':None}]
        watch.storage.SCAN_LIMIT = 1
        assert post('query', options).status_code == 503
        with pytest.raises(ValueError, match='scan limit'):
            watch.aggregate({'metric':'latency.duration','aggregation':'avg'})
    finally:
        watch.stop(); engine.dispose()
