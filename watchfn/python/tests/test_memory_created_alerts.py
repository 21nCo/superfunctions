"""Default memory mode reuses real SQLite outbox and HTTP delivery."""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from watchfn import WatchFn, AlertConflict
from watchfn.alerts.alert_manager import Alert
from test_alert_dispatch import endpoint  # noqa: F401
from test_durable_alerts import definition


@pytest.fixture
def memory_watch():
    watch = WatchFn('memory-created')
    watch.system_metrics.start = lambda: None
    watch.process_metrics.start = lambda: None
    watch.start()
    try:
        yield watch
    finally:
        watch.stop()
        if watch.alerts._engine is not None:
            watch.alerts._engine.dispose()


def legacy(identifier='legacy'):
    return Alert(identifier, 'legacy', None, True, dict(definition()['condition'], type='threshold'), 'warning', [])


def test_memory_created_real_http_restart_receipt_and_legacy_identity(memory_watch, endpoint):
    watch = memory_watch
    url, state = endpoint
    item = legacy()
    watch.alerts.register(item)
    record = watch.alerts.create(dict(definition(), channels=[{'type': 'webhook', 'webhook': url}]))
    assert watch.alerts.get(item.id) is item
    watch.track('api', {'latency': 20})
    results = watch.alerts.evaluate_stored()
    assert {result.alert.id for result in results} == {item.id, record['id']}
    assert item.state == 'triggered'
    assert len(watch.alerts.notifications()) == 1
    assert watch.alerts.process_notifications()['processed'] == 1
    assert len(state['requests']) == 1
    watch.stop()
    assert watch.alerts._created.storage._thread is None
    watch.start()
    assert watch.alerts.get(item.id) is item
    assert watch.alerts.get_record(record['id'])['state'] == 'triggered'
    assert watch.alerts.notifications()[0]['outcome'] == 'delivered'
    assert watch.alerts.process_notifications()['processed'] == 0
    assert len(state['requests']) == 1
    assert len(watch.alerts.get_all()) == 2
    assert len(watch.alerts.list()) == 1  # Created-alert pagination only.
    assert len(watch.alerts.get_triggered()) == 2


def test_legacy_mutation_and_implicit_recovery_remain(memory_watch):
    watch = memory_watch
    item = legacy()
    watch.alerts.register(item)
    watch.alerts.create(dict(definition(), channels=[]))
    watch.alerts.evaluate(item, {'api.latency': [{'value': 20}]})
    assert item.state == 'triggered'
    watch.alerts.evaluate(item, {'api.latency': [{'value': 0}]})
    assert item.state == 'normal'
    item.condition['threshold'] = 100
    watch.track('api', {'latency': 20})
    assert watch.alerts.evaluate_stored()[0].matched is False
    watch.alerts.disable(item.id)
    assert item.enabled is False
    watch.alerts.enable(item.id)
    assert item.enabled is True


def test_created_id_collision_rejected_and_page_does_not_repeat_legacy(memory_watch, monkeypatch):
    watch = memory_watch
    item = legacy()
    watch.alerts.register(item)
    record = watch.alerts.create(dict(definition(), channels=[]))
    with pytest.raises(AlertConflict):
        watch.alerts.register(legacy(record['id']))
    monkeypatch.setattr('watchfn.alerts.memory_durable.uuid4', lambda: item.id)
    with pytest.raises(AlertConflict):
        watch.alerts.create(dict(definition(), channels=[]))
    assert watch.alerts.get(item.id) is item
    assert watch.alerts.evaluate_stored(after=record['id']) == []
    assert item.last_evaluated is None
    with pytest.raises(ValueError):
        watch.alerts.evaluate_stored(limit=101)
    assert item.last_evaluated is None


def test_lost_http_ack_is_retained_across_memory_restart(memory_watch, endpoint):
    watch = memory_watch
    url, state = endpoint
    state['drop'] = True
    record = watch.alerts.create(dict(definition(), channels=[{'type': 'webhook', 'webhook': url}]))
    watch.alerts.trigger(record['id'])
    watch.alerts.process_notifications()
    assert watch.alerts.notifications()[0]['outcome'] == 'unknown'
    watch.stop(); watch.start()
    assert watch.alerts.process_notifications()['processed'] == 0
    assert len(state['requests']) == 1
    assert watch.alerts.notifications()[0]['outcome'] == 'unknown'


def test_shared_callbacks_reentry_and_stop_drains(memory_watch):
    watch = memory_watch
    record = watch.alerts.create(dict(definition(), channels=[]))
    entered, release = threading.Event(), threading.Event()
    calls = []
    def callback(item, context):
        calls.append(item['id'])
        assert watch.alerts.get_record(item['id'])['state'] == 'triggered'
        with pytest.raises(RuntimeError, match='callback'):
            watch.stop()
        entered.set()
        assert release.wait(5)
    watch.alerts.on_trigger(callback)
    with ThreadPoolExecutor(2) as pool:
        trigger = pool.submit(watch.alerts.trigger, record['id'])
        assert entered.wait(5)
        stop = pool.submit(watch.stop)
        assert not stop.done()
        release.set()
        trigger.result(timeout=5)
        stop.result(timeout=5)
    assert calls == [record['id']]
    assert watch.alerts._created.storage._thread is None
    watch.start()


def test_unknown_create_commit_reserves_identity_across_restart(memory_watch, monkeypatch):
    watch = memory_watch
    backend = watch.alerts._backend()
    create = backend._create
    monkeypatch.setattr('watchfn.alerts.memory_durable.uuid4', lambda: 'uncertain-created')
    def lost_ack(*args):
        create(*args)
        raise RuntimeError('owned post-commit failure')
    monkeypatch.setattr(backend, '_create', lost_ack)
    with pytest.raises(RuntimeError, match='post-commit'):
        watch.alerts.create(dict(definition(), channels=[]))
    with pytest.raises(AlertConflict):
        watch.alerts.register(legacy('uncertain-created'))
    watch.stop()
    with pytest.raises(AlertConflict):
        watch.alerts.register(legacy('uncertain-created'))
    watch.start()
    assert watch.alerts.get_record('uncertain-created')['state'] == 'normal'
    with pytest.raises(AlertConflict):
        watch.alerts.register(legacy('uncertain-created'))
