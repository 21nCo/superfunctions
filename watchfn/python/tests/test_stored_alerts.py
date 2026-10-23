from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from superfunctions_sqlalchemy import create_adapter
from watchfn import Event, WatchFn
from watchfn.alerts.alert_manager import Alert
from watchfn.alerts.observations import evaluate, observations
from test_database import migrate, start


def rule(metric='api.latency', **kwargs):
    return dict(metric=metric, operator='gt', threshold=10, window='5m', **kwargs)


def alert(condition=None, **kwargs):
    return Alert('a', 'latency', None, True, condition or rule(), 'warning', [], **kwargs)


def event(name, properties, when=1000000):
    return Event(type='track', name=name, properties=properties, timestamp=datetime.fromtimestamp(when / 1000, timezone.utc))


def memory():
    watch = WatchFn('alerts')
    watch.system_metrics.start = lambda: None
    watch.process_metrics.start = lambda: None
    watch.start()
    return watch


def test_track_flush_composite_independent_metrics_and_explicit_recovery():
    watch = memory()
    try:
        watch.track('api', {'latency': 20})
        watch.track('requests', {'value': 2})
        condition = {'type': 'composite', 'operator': 'and', 'conditions': [rule(), rule('requests')]}
        item = alert(condition)
        watch.alerts.register(item)
        assert watch.alerts.evaluate_stored()[0].matched is False
        watch.track('requests', {'value': 40})
        assert watch.alerts.evaluate_stored()[0].matched is True
        assert item.state == 'triggered'
        # Future empty window is unknown, never an implicit resolution.
        future = int(item.last_evaluated) + 600000
        assert watch.alerts.evaluate_stored(now=future)[0].matched is None
        assert item.state == 'triggered'
        item.auto_resolve = {'enabled': True, 'condition': rule('recovery')}
        watch.storage.add(event('recovery', {'value': 20}, future))
        assert watch.alerts.evaluate_stored(now=future)[0].matched is None
        assert item.state == 'normal'
    finally: watch.stop()
    with pytest.raises(RuntimeError): watch.alerts.evaluate_stored()


def test_windows_boundaries_numeric_and_exact_selection():
    events = [event('api', {'latency': 20}), event('api.latency', {'value': None})]
    assert observations(events, 'api.latency', 700000, 1000000, 10) == []
    events.pop()
    events.extend([event('api', {'latency': True}), event('api', {'latency': '20'}), event('api', {'latency': 99}, 1000001), event('api', {'latency': 99}, 699999)])
    assert observations(events, 'api.latency', 700000, 1000000, 1) == [{'value': 20, 'timestamp': 1000000}]
    data = {'api.latency': [{'value': 20, 'timestamp': 700000}]}
    assert evaluate(rule(), data, 1000000) is True
    assert evaluate(rule(), data, 1000001) is None


def test_capacity_and_failure_leave_state_untouched():
    watch = memory()
    try:
        item = alert()
        watch.alerts.register(item)
        watch.storage.add(event('api', {'latency': 20}))
        watch.storage.add(event('api', {'latency': 30}))
        with pytest.raises(ValueError, match='capacity'): watch.alerts.evaluate_stored(now=1000000, maximum=1)
        assert item.last_evaluated is None and item.state == 'normal'
        original = watch.storage.query
        def failure(): raise RuntimeError('storage failed')
        watch.storage.query = failure
        with pytest.raises(RuntimeError): watch.alerts.evaluate_stored(now=1000000)
        assert item.last_evaluated is None
        watch.storage.query = original
        item.condition = {'type': 'composite', 'operator': 'and', 'conditions': []}
        watch.storage.query = failure
        with pytest.raises(ValueError): watch.alerts.evaluate_stored(now=1000000)
    finally: watch.stop()


def test_sqlite_stored_producer_query_alert_reopen(tmp_path):
    path = 'sqlite:///' + str(tmp_path / 'observations.sqlite')
    engine = create_engine(path)
    migrate(engine)
    watch = start(create_adapter(engine))
    try:
        watch.track('api', {'latency': 20})
        watch.alerts.register(alert())
        assert watch.alerts.evaluate_stored()[0].matched is True
        assert watch.aggregate({'metric': 'api.latency', 'aggregation': 'avg'})[0]['value'] == 20
    finally: watch.stop(); engine.dispose()
    engine = create_engine(path)
    watch = start(create_adapter(engine))
    try:
        assert watch.alerts.get_all() == []  # Definitions are explicitly not durable yet.
        watch.alerts.register(alert())
        assert watch.alerts.evaluate_stored()[0].matched is True
        watch.storage.SCAN_LIMIT = 0
        with pytest.raises(ValueError, match="scan limit"):
            watch.alerts.evaluate_stored()
    finally: watch.stop(); engine.dispose()


@pytest.mark.parametrize('operator, expected', [('and', False), ('or', None)])
def test_unknown_composite_truth_table(operator, expected):
    condition = {'type': 'composite', 'operator': operator, 'conditions': [rule('a'), rule('b')]}
    assert evaluate(condition, {'a': [{'value': 0, 'timestamp': 1000000}]}, 1000000) is expected


def test_anomaly_zero_history_and_order():
    condition = dict(type='anomaly', metric='a', minDataPoints=3, sensitivity=.8, algorithm='moving-average')
    assert evaluate(condition, {'a': [{'value': 5, 'timestamp': 3}, {'value': 0, 'timestamp': 1}, {'value': 0, 'timestamp': 2}]}, 3) is True
    assert evaluate(condition, {'a': [{'value': 0, 'timestamp': 1}]}, 3) is None


def test_shared_alert_vectors():
    import json
    from pathlib import Path
    for case in json.loads((Path(__file__).parent / 'fixtures/alert-golden.json').read_text()):
        assert evaluate(case['condition'], case['data'], case['now']) is case['expected'], case['name']


@pytest.mark.parametrize('database', [False, True])
def test_same_metric_children_select_presence_in_each_window(tmp_path, database):
    engine = create_engine('sqlite:///' + str(tmp_path / 'windows.sqlite')) if database else None
    if engine is not None: migrate(engine)
    watch = start(create_adapter(engine)) if engine is not None else memory()
    try:
        import json
        from pathlib import Path
        case = json.loads((Path(__file__).parent / 'fixtures/alert-window-golden.json').read_text())
        now = case['now']
        watch.storage.add_batch([event(row['name'], row['properties'], row['timestamp']) for row in case['events']])
        watch.alerts.register(alert(case['condition']))
        assert watch.alerts.evaluate_stored(now=now)[0].matched is case['expected']
        # An invalid narrow-window exact sample suppresses only its own fallback.
        row = case['invalidExact']
        watch.storage.add_batch([event(row['name'], row['properties'], row['timestamp'])])
        assert watch.alerts.evaluate_stored(now=now)[0].matched is case['expectedAfterInvalid']
    finally:
        watch.stop()
        if engine is not None: engine.dispose()
