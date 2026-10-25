from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from superfunctions_sqlalchemy import create_adapter
from watchfn import Event, WatchFn, QueryValidationError
from watchfn.trace.tracer import Tracer
from test_database import migrate, start
from test_stored_alerts import memory


@pytest.fixture(params=['memory', 'database'])
def watch(request, tmp_path):
    engine = None
    if request.param == 'database':
        engine = create_engine('sqlite:///' + str(tmp_path / 'trace.sqlite'))
        migrate(engine)
        value = start(create_adapter(engine))
    else:
        value = memory()
    try:
        yield value
    finally:
        value.stop()
        if engine is not None:
            engine.dispose()


def test_public_recording_once_error_and_stored_queries(watch):
    span = watch.trace.start_span('checkout', trace_id='t1')
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: span.finish(), range(12)))
    watch.trace.finish_span(span)
    watch.batcher.flush()
    rows = watch.trace.query({'operation': 'checkout', 'traceId': 't1', 'duration': {'gte': 0}})
    assert len(rows) == 1
    assert rows[0]['id'] == span.span_id
    assert rows[0]['service'] == watch.config.name
    assert rows[0]['startTime'] <= rows[0]['endTime']
    assert rows[0]['span_id'] == span.span_id  # Legacy field retained.
    rows[0]['tags']['changed'] = True
    assert 'changed' not in watch.trace.query({'traceId': 't1'})[0]['tags']
    with pytest.raises(ValueError, match='owned failure'):
        with watch.trace.trace('failed', trace_id='t1', parent_span_id=span.span_id):
            raise ValueError('owned failure')
    watch.batcher.flush()
    assert len(watch.trace.query({'status': 'error'})) == 1
    detail = watch.trace.get_trace({'traceId': 't1', 'includeSpans': True})
    assert detail['status'] == 'error' and len(detail['spans']) == 2
    assert 'spans' not in watch.trace.get_trace({'traceId': 't1'})
    assert watch.trace.get_trace({'traceId': 'missing'}) is None
    assert watch.trace.active_spans == {}


def test_correlation_service_edges_windows_and_validation(watch):
    now = 1000000
    when = datetime.fromtimestamp(now / 1000, timezone.utc)
    def span(identity, trace_id, service, parent=None, error=False):
        return Event(type='track', name='trace.span', timestamp=when, properties=dict(id=identity, traceId=trace_id, name='checkout', service=service, startTime=now-100, endTime=now, duration=100, tags={'error': error}, logs=[], **({'parentId': parent} if parent else {})))
    root = span('root', 't1', 'api')
    for event in [root, span('child', 't1', 'db', 'root', True), span('local', 't1', 'api', 'root'), span('orphan', 't2', 'worker', 'root'), Event(type='log', timestamp=when, properties={'traceId': 't1', 'message': 'related'}), Event(type='log', timestamp=when, properties={'traceId': 't2', 'message': 'unrelated'})]:
        watch.storage.add(event)
    assert len(watch.trace.query({'timeRange': [now, now], 'status': 'error', 'duration': {'gte': 100}, 'orderBy': {'field': 'duration', 'direction': 'desc'}})) == 1
    assert watch.trace.query({'duration': {'gt': 100}}) == []
    detail = watch.trace.get_trace({'traceId': 't1', 'includeLogs': True})
    assert len(detail['logs']) == 1 and detail['logs'][0]['properties']['message'] == 'related'
    assert watch.trace.get_service_map({}) == dict(nodes=[{'service': 'api'}, {'service': 'db'}, {'service': 'worker'}], edges=[dict(source='api', target='db', calls=1, errors=1, averageDuration=100)], unlinkedSpans=1)
    assert watch.trace.get_service_map({'minCalls': 2})['edges'] == []
    for invalid in [True, -1, float('nan'), {}, {'gt': '1'}, {'contains': 1}]:
        with pytest.raises(QueryValidationError, match='duration'):
            watch.trace.query({'duration': invalid})
    with pytest.raises(QueryValidationError):
        watch.trace.get_service_map({'minCalls': True})
    # A new storage event with the same span identity is an ambiguous trace.
    watch.storage.add(root.model_copy(deep=True, update={'name': 'trace.span'})) if watch.config.storage == 'memory' else watch.storage.add(span('root', 't1', 'api'))
    with pytest.raises(QueryValidationError, match='Duplicate'):
        watch.trace.get_trace({'traceId': 't1'})
    with pytest.raises(QueryValidationError, match='Duplicate'):
        watch.trace.get_service_map({})


def test_failed_recording_retries_original_timing_and_inactive_host():
    attempts = []
    def record(_name, data):
        attempts.append(data)
        if len(attempts) == 1:
            raise RuntimeError('storage')
    tracer = Tracer('api', record)
    span = tracer.start_span('retry')
    with pytest.raises(RuntimeError): span.finish()
    assert span.span_id in tracer.active_spans
    span.finish(); span.finish()
    assert len(attempts) == 2 and attempts[0] == attempts[1]
    assert not tracer.active_spans
    host = WatchFn('inactive')
    with pytest.raises(RuntimeError, match='unavailable'): host.trace.start_span('x').finish()
    with pytest.raises(RuntimeError, match='unavailable'): host.trace.query({})


def test_sqlite_reopen_and_callback_query_without_flush(tmp_path):
    from test_alert_callbacks import setup
    from test_durable_alerts import definition
    engine, watch = setup(tmp_path)
    try:
        with watch.trace.trace('persisted', trace_id='durable'):
            pass
        watch.batcher.flush()
        alert = watch.alerts.create(definition())
        def callback(item, _context):
            spans = watch.trace.query({'traceId': 'durable'})
            watch.alerts.add_note(item['id'], content='Spans: ' + str(len(spans)), created_by='callback')
        watch.alerts.on_trigger(callback)
        watch.alerts.trigger(alert['id'])
        assert watch.alerts.get_record(alert['id'])['notes'][0]['content'] == 'Spans: 1'
        watch.stop()
        reopened = start(create_adapter(engine))
        try:
            assert reopened.trace.get_trace({'traceId': 'durable'})['status'] == 'ok'
        finally:
            reopened.stop()
    finally:
        watch.stop(); engine.dispose()


def test_capacity_is_rejected_instead_of_truncating_trace():
    from watchfn.trace.queries import TraceQueries, StoredTraceQuery
    from watchfn.query import Query
    events = [Event(type='track', name='trace.span', properties=dict(id=str(index), traceId='large', name='call', startTime=0, endTime=1, duration=1)) for index in range(10001)]
    queries = TraceQueries(lambda options: StoredTraceQuery(options).execute(events))
    with pytest.raises(QueryValidationError, match='capacity'):
        queries.get_trace({'traceId': 'large'})
    with pytest.raises(QueryValidationError, match='capacity'):
        queries.get_service_map({})
    with pytest.raises(QueryValidationError, match='1000'):
        Query({'limit': 1001})  # Public generic query capacity is unchanged.


def test_stop_joins_admitted_span_enqueue_before_final_flush():
    import threading
    watch = memory()
    span = watch.trace.start_span('shutdown', trace_id='stop-race')
    entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
    original = watch.batcher.add
    def held_add(event):
        entered.set()
        assert release.wait(5)
        original(event)
    watch.batcher.add = held_add
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            finishing = pool.submit(span.finish)
            assert entered.wait(5)
            def stop():
                watch.stop(); stopped.set()
            stopping = pool.submit(stop)
            assert not stopped.wait(.05)
            release.set()
            finishing.result(5); stopping.result(5)
        assert len(watch.storage.query('trace.span')) == 1
        assert span._recorded and not watch.trace.active_spans
        assert not watch.batcher._pending
    finally:
        release.set(); watch.batcher.add = original; watch.stop()
