import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest
from sqlalchemy import Column, MetaData, String, Table, Text, Index, create_engine
from superfunctions_sqlalchemy import create_adapter
from watchfn import WatchFn, Event, get_business_schema
from watchfn.storage.events import decode_event, encode_event
from test_database import migrate, http


def open_watch(name='funnel', database=None):
    watch = WatchFn(name, **({'storage': 'database', 'database': database} if database else {}), auth={'apiKey': 'secret'})
    watch.system_metrics.start = lambda: None
    watch.process_metrics.start = lambda: None
    watch.start()
    return watch


def definition():
    return {'name': 'purchase', 'steps': [{'event': 'cart'}, {'event': 'paid'}], 'timeWindow': '1m'}


def append(watch, name, at, user='u', app=None, **properties):
    value = {'type': 'track', 'name': name, 'app': {'name': app or watch.config.name}, 'timestamp': datetime.fromtimestamp(at / 1000, timezone.utc).isoformat(), 'properties': {'userId': user, **properties}}
    watch.storage.add(decode_event(json.dumps(value)))


def query(**extra):
    return {'name': 'purchase', 'timeRange': {'from': 0, 'to': 100000}, **extra}


def migrate_business(engine):
    metadata = MetaData()
    for schema in get_business_schema().values():
        table = Table(schema.name, metadata, *[Column(field.name, Text if field.type == 'text' else String, primary_key=field.primary_key, nullable=field.nullable, unique=field.unique) for field in schema.fields])
        for index in schema.indexes or []: Index(index.name, *[table.c[field] for field in index.fields], unique=index.unique)
    metadata.create_all(engine)


def test_memory_funnel_order_window_filters_cohorts_and_restart():
    watch = open_watch()
    try:
        config = definition(); config['steps'][0]['filters'] = {'allowed': True}
        watch.business.create_funnel(config); config['steps'].clear()
        append(watch, 'paid', 1, 'out-of-order')
        append(watch, 'cart', 2, 'out-of-order', allowed=True, source='a')
        append(watch, 'cart', 3, 'complete', allowed=True, source='b')
        append(watch, 'paid', 4, 'complete', source='changed')
        append(watch, 'cart', 5, 'expired', allowed=True, source='b')
        append(watch, 'paid', 70000, 'expired')
        append(watch, 'cart', 6, 'boolean', allowed=1, source='a')
        append(watch, 'paid', 7, 'boolean')
        result = watch.business.get_funnel(query(groupBy='source'))
        assert [step['count'] for step in result['steps']] == [3, 1]
        assert result['overallConversion'] == 1 / 3 * 100
        assert [group['group'] for group in result['groups']] == ['a', 'b']
        assert watch.business.get_dropoff_analysis({'funnel': 'purchase', 'step': 1, 'timeRange': {'from': 0, 'to': 100000}})['dropped'] == 2
        watch.stop()
        with pytest.raises(RuntimeError): watch.business.get_funnel(query())
        watch.start()
        assert [step['count'] for step in watch.business.get_funnel(query())['steps']] == [3, 1]
        with pytest.raises(ValueError): watch.business.create_funnel(definition())
    finally: watch.stop()


@pytest.mark.parametrize('reverse', [False, True])
def test_simultaneous_attempts_preserve_older_valid_chain(reverse):
    watch = open_watch()
    try:
        watch.business.create_funnel(definition()); append(watch, 'cart', 1)
        for name in (['paid', 'cart'] if reverse else ['cart', 'paid']): append(watch, name, 2)
        assert [step['count'] for step in watch.business.get_funnel(query())['steps']] == [1, 1]
    finally: watch.stop()


def test_track_snapshot_legacy_rejection_and_ordinary_event_shape():
    watch = open_watch()
    try:
        watch.business.create_funnel(definition()); properties = {'userId': 'u', 'nested': {'value': 1}}
        watch.business.track('cart', properties); properties['nested']['value'] = 2; watch.flush()
        stored = watch.storage.query()[0]
        assert stored.properties['nested']['value'] == 1
        assert stored.model_dump()['app'] == {'name': 'funnel'}
        assert 'app' not in Event(type='track').model_dump()
        assert decode_event(encode_event(stored)).model_dump()['app'] == {'name': 'funnel'}
        with pytest.raises(ValueError): watch.business.track('cart', {'text': 'x' * 65536})
        watch.storage.add(Event(type='track', name='cart', properties={'userId': 'old'}))
        with pytest.raises(ValueError, match='ownership'): watch.business.get_funnel({'name': 'purchase', 'timeRange': 'last-1h'})
        for bad in [{'type': 'metric', 'app': {'name': 'funnel'}, 'timestamp': '2026-01-01T00:00:00Z'}, {'type': 'track', 'name': 'cart', 'properties': {}, 'timestamp': '2026-01-01T00:00:00Z', 'app': {'name': 'funnel', 'extra': True}}]:
            with pytest.raises(ValueError): decode_event(json.dumps(bad))
    finally: watch.stop()


def test_native_sqlite_reopen_and_namespace_isolation(tmp_path):
    url = 'sqlite:///' + str(tmp_path / 'funnels.sqlite'); engine = create_engine(url); migrate(engine); migrate_business(engine)
    watch = open_watch(database=create_adapter(engine))
    try:
        watch.business.create_funnel(definition()); append(watch, 'cart', 1); append(watch, 'paid', 2)
        append(watch, 'cart', 1, user='foreign', app='other'); append(watch, 'paid', 2, user='foreign', app='other')
    finally: watch.stop(); engine.dispose()
    engine = create_engine(url); watch = open_watch(database=create_adapter(engine))
    try:
        assert [step['count'] for step in watch.business.get_funnel(query())['steps']] == [1, 1]
        with ThreadPoolExecutor(2) as workers:
            futures = [workers.submit(watch.business.create_funnel, {**definition(), 'name': 'race'}) for _ in range(2)]
            outcomes = []
            for future in futures:
                try: future.result(); outcomes.append(True)
                except Exception: outcomes.append(False)
            assert sorted(outcomes) == [False, True]
    finally: watch.stop(); engine.dispose()


def test_stop_joins_admitted_business_query():
    watch = open_watch(); watch.business.create_funnel(definition())
    entered, release = threading.Event(), threading.Event(); original = watch.storage.query
    def held(*args): entered.set(); assert release.wait(2); return original(*args)
    watch.storage.query = held
    with ThreadPoolExecutor(2) as workers:
        running = workers.submit(watch.business.get_funnel, query()); assert entered.wait(2)
        stopping = workers.submit(watch.stop)
        try:
            assert not stopping.done(); release.set(); assert running.result()['steps'][0]['count'] == 0; stopping.result()
        finally: release.set(); watch.stop()


@pytest.mark.parametrize('framework', ['fastapi', 'flask'])
def test_canonical_track_http_preserves_owned_app_only(framework):
    watch = open_watch()
    try:
        post, body = http(watch, framework)
        value = {'type': 'track', 'name': 'cart', 'app': {'name': 'funnel'}, 'timestamp': '2026-01-01T00:00:00Z', 'properties': {'userId': 'u'}}
        assert post('ingest', [value]).status_code == 202
        assert watch.storage.query()[0].model_dump()['app'] == {'name': 'funnel'}
        assert post('ingest', [{**value, 'app': {'name': 'foreign'}}]).status_code == 400
        assert post('ingest', [{**value, 'extra': True}]).status_code == 400
    finally: watch.stop()


def test_canonical_submillisecond_order_and_invalid_filter():
    watch = open_watch()
    try:
        watch.business.create_funnel(definition())
        for name, fraction in [('cart', '000100'), ('paid', '000900')]:
            event = decode_event(json.dumps({'type': 'track', 'name': name, 'app': {'name': 'funnel'}, 'timestamp': '2026-01-01T00:00:00.' + fraction + 'Z', 'properties': {'userId': 'u'}}))
            assert event.timestamp.microsecond == 0
            watch.storage.add(event)
        result = watch.business.get_funnel({'name': 'purchase', 'timeRange': {'from': '2026-01-01T00:00:00Z', 'to': '2026-01-01T00:00:01Z'}})
        assert [step['count'] for step in result['steps']] == [1, 0]
        bad = definition(); bad['name'] = 'invalid'; bad['steps'][0]['filters'] = {'value': '\ud800'}
        with pytest.raises(ValueError): watch.business.create_funnel(bad)
        for stamp in [-0.9, 0.9]:
            event = decode_event(json.dumps({'type': 'track', 'name': 'cart', 'app': {'name': 'funnel'}, 'timestamp': stamp, 'properties': {}}))
            assert event.timestamp.timestamp() == 0
    finally: watch.stop()


def test_numeric_groups_match_javascript_without_boolean_collapse():
    watch = open_watch()
    try:
        watch.business.create_funnel(definition())
        for index, value in enumerate([1, 1.0, -0.0, 0, True]):
            append(watch, 'cart', index + 1, user=str(index), source=value)
        groups = watch.business.get_funnel(query(groupBy='source'))['groups']
        assert [(type(group['group']), group['group'], group['steps'][0]['count']) for group in groups] == [(int, 0, 2), (int, 1, 2), (bool, True, 1)]
    finally: watch.stop()


def test_exact_window_and_query_boundaries_use_integer_milliseconds():
    watch = open_watch()
    try:
        watch.business.create_funnel(definition())
        append(watch, 'cart', 4001); append(watch, 'paid', 64001)
        assert [step['count'] for step in watch.business.get_funnel({'name': 'purchase', 'timeRange': {'from': 4001.5, 'to': 64001}})['steps']] == [0, 0]
        for bounds in [{'from': 4001, 'to': 64001}, {'from': '1970-01-01T00:00:04.001Z', 'to': '1970-01-01T00:01:04.001Z'}]:
            assert [step['count'] for step in watch.business.get_funnel({'name': 'purchase', 'timeRange': bounds})['steps']] == [1, 1]
    finally: watch.stop()
