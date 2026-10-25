import asyncio
import threading
import pytest
from test_durable_alerts import open_watch, migrate_alerts, definition
from test_database import migrate


def setup(tmp_path):
    engine, watch = open_watch('sqlite:///' + str(tmp_path / 'callbacks.sqlite'))
    migrate(engine); migrate_alerts(engine)
    return engine, watch


def test_callbacks_are_after_commit_isolated_and_not_replayed(tmp_path):
    engine, watch = setup(tmp_path)
    try:
        alert = watch.alerts.create(definition())
        seen = []
        def corrupt(item, context):
            item['name'] = 'corrupt'; context['threshold'] = -1
        async def observe(item, context):
            await asyncio.sleep(0)
            assert watch.alerts.get_record(item['id'])['state'] == 'triggered'
            watch.alerts.add_note(item['id'], content='committed', created_by='callback')
            seen.append((item, context))
        watch.alerts.on_trigger(corrupt); watch.alerts.on_trigger(observe)
        result = watch.alerts.trigger(alert['id'])
        assert result['name'] == 'slow' and seen[0][0]['name'] == 'slow'
        assert seen[0][1]['threshold'] == 10
        assert watch.alerts.get_record(alert['id'])['notes'][0]['content'] == 'committed'
        watch.alerts.trigger(alert['id'])
        assert len(seen) == 1
        resolved = []
        watch.alerts.on_resolve(lambda item, context: resolved.append((item, context)))
        watch.alerts.resolve(alert['id'], resolved_by='operator')
        assert resolved[0][0]['state'] == 'resolved' and resolved[0][1]['duration'] >= 0
    finally:
        watch.stop(); engine.dispose()


def test_listener_failure_does_not_rollback_or_skip_other_listeners(tmp_path):
    engine, watch = setup(tmp_path)
    try:
        alert = watch.alerts.create(definition()); seen = []
        def fail(*args): raise ValueError('private callback secret')
        watch.alerts.on_trigger(fail)
        watch.alerts.on_trigger(lambda *args: seen.append(True))
        with pytest.raises(RuntimeError, match='transition committed') as error:
            watch.alerts.trigger(alert['id'])
        assert 'private callback secret' not in str(error.value)
        assert seen == [True] and watch.alerts.get_record(alert['id'])['state'] == 'triggered'
        assert len(watch.alerts.notifications()) == 1
        watch.alerts.trigger(alert['id']); assert seen == [True]
    finally:
        watch.stop(); engine.dispose()


@pytest.mark.asyncio
async def test_async_entry_and_cancel_join_callback_owner(tmp_path):
    engine, watch = setup(tmp_path)
    release = threading.Event(); entered = threading.Event()
    try:
        alert = watch.alerts.create(definition())
        async def callback(item, context):
            entered.set()
            await asyncio.to_thread(release.wait)
            watch.alerts.add_note(item['id'], content='joined', created_by='callback')
        watch.alerts.on_trigger(callback)
        with pytest.raises(RuntimeError, match='async alert lifecycle'):
            watch.alerts.trigger(alert['id'])
        assert watch.alerts.get_record(alert['id'])['state'] == 'normal'
        operation = asyncio.create_task(watch.alerts.trigger_async(alert['id']))
        assert await asyncio.to_thread(entered.wait, 5)
        operation.cancel(); await asyncio.sleep(0)
        assert not operation.done()
        release.set()
        with pytest.raises(asyncio.CancelledError): await operation
        assert watch.alerts.get_record(alert['id'])['notes'][0]['content'] == 'joined'
        await watch.alerts.resolve_async(alert['id'], resolved_by='operator')
        assert watch.alerts.get_record(alert['id'])['state'] == 'resolved'
    finally:
        release.set(); watch.stop(); engine.dispose()


def test_stop_joins_callbacks_before_closing_storage(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    engine, watch = setup(tmp_path)
    entered, release, stopping = threading.Event(), threading.Event(), threading.Event()
    try:
        alert = watch.alerts.create(definition())
        def callback(item, context):
            entered.set(); assert release.wait(5)
            watch.alerts.add_note(item['id'], content='before close', created_by='callback')
        watch.alerts.on_trigger(callback)
        def stop(): stopping.set(); watch.stop()
        with ThreadPoolExecutor(max_workers=2) as executor:
            transition = executor.submit(watch.alerts.trigger, alert['id'])
            assert entered.wait(5)
            shutdown = executor.submit(stop); assert stopping.wait(5)
            assert not shutdown.done()
            release.set(); transition.result(5); shutdown.result(5)
        watch.start()
        assert watch.alerts.get_record(alert['id'])['notes'][0]['content'] == 'before close'
        with pytest.raises(TypeError): watch.alerts.on_trigger(None)
    finally:
        release.set(); watch.stop(); engine.dispose()


def test_callback_cannot_stop_its_own_owner(tmp_path):
    engine, watch = setup(tmp_path)
    try:
        alert = watch.alerts.create(definition())
        watch.alerts.on_trigger(lambda *_: watch.stop())
        with pytest.raises(RuntimeError, match='transition committed'):
            watch.alerts.trigger(alert['id'])
        assert watch.is_started and watch.alerts.get_record(alert['id'])['state'] == 'triggered'
    finally: watch.stop(); engine.dispose()


def test_memory_stored_callbacks_release_evaluation_lock():
    from test_stored_alerts import memory, alert, event
    watch = memory(); seen = []
    try:
        item = alert()
        item.auto_resolve = {'enabled': True, 'condition': {'metric': 'recover', 'operator': 'lt', 'threshold': 2, 'window': '1s'}}
        watch.alerts.register(item)
        def callback(value, context):
            value.name = 'changed'
            seen.append(context)
            # Reentry would deadlock if listener dispatch retained the evaluation lock.
            watch.alerts.evaluate_stored(now=context['timestamp'])
        watch.alerts.on_trigger(callback)
        watch.alerts.on_resolve(lambda value, context: seen.append(context))
        watch.storage.add(event('api', {'latency': 20}))
        watch.alerts.evaluate_stored(now=1000000)
        assert seen[0]['value'] == 20 and seen[0]['threshold'] == 10 and item.name == 'latency'
        watch.storage.add(event('recover', {'value': 0}, 1010000))
        watch.alerts.evaluate_stored(now=1010000)
        assert seen[1]['value'] == 0 and seen[1]['threshold'] == 2 and seen[1]['duration'] == 10000
    finally: watch.stop()


def test_memory_legacy_callbacks_preserve_implicit_recovery():
    from watchfn.alerts.alert_manager import AlertManager, Alert
    manager = AlertManager(); seen = []
    item = Alert('a', 'legacy', None, True, {'type': 'threshold', 'metric': 'value', 'operator': 'gt', 'threshold': 10, 'window': '1m'}, 'warning', [])
    manager.register(item)
    manager.on_trigger(lambda value, context: seen.append(('triggered', value.state, context)))
    manager.on_resolve(lambda value, context: seen.append(('resolved', value.state, context)))
    manager.evaluate(item, {'value': [{'value': 20}]})
    manager.evaluate(item, {'value': [{'value': 0}]})
    assert [(event, state) for event, state, context in seen] == [('triggered', 'triggered'), ('resolved', 'normal')]
    assert seen[0][2]['threshold'] == 10 and 'value' not in seen[0][2]


def test_async_callback_cannot_stop_owner_through_to_thread(tmp_path):
    engine, watch = setup(tmp_path)
    try:
        alert = watch.alerts.create(definition())
        async def callback(*args):
            with pytest.raises(RuntimeError, match='own|callback'):
                await asyncio.to_thread(watch.stop)
        watch.alerts.on_trigger(callback)
        watch.alerts.trigger(alert['id'])
        assert watch.is_started
    finally: watch.stop(); engine.dispose()


def test_stop_preserves_inherited_async_callback_note_admission(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    engine, watch = setup(tmp_path)
    entered, release, draining = threading.Event(), threading.Event(), threading.Event()
    try:
        alert = watch.alerts.create(definition())
        async def callback(item, context):
            entered.set(); await asyncio.to_thread(release.wait)
            await asyncio.to_thread(watch.alerts.add_note, item['id'], content='inherited', created_by='callback')
        watch.alerts.on_trigger(callback)
        # Signal the exact wait boundary: admission is closed while the owner is held.
        condition = watch.alerts._callbacks._lock
        original_wait = condition.wait
        def wait(timeout=None):
            draining.set()
            return original_wait(timeout)
        condition.wait = wait
        with ThreadPoolExecutor(max_workers=2) as executor:
            transition = executor.submit(watch.alerts.trigger, alert['id'])
            assert entered.wait(5)
            shutdown = executor.submit(watch.stop); assert draining.wait(5)
            release.set(); transition.result(5); shutdown.result(5)
        watch.start()
        assert watch.alerts.get_record(alert['id'])['notes'][0]['content'] == 'inherited'
    finally: release.set(); watch.stop(); engine.dispose()


def test_lazy_memory_alerts_cannot_admit_after_host_stop():
    from watchfn import WatchFn
    from test_stored_alerts import alert
    watch = WatchFn('lazy'); watch.stop()
    item = alert(); watch.alerts.register(item)
    with pytest.raises(RuntimeError, match='stopped'):
        watch.alerts.evaluate(item, {})
    assert item.state == 'normal'


def test_memory_evaluation_batch_snapshots_definitions_for_callbacks():
    from watchfn.alerts.alert_manager import AlertManager, Alert
    manager = AlertManager(); seen = []
    def item(identifier):
        return Alert(identifier, identifier, None, True, {'type': 'threshold', 'metric': 'value', 'operator': 'gt', 'threshold': 10, 'window': '1m'}, 'warning', [])
    manager.register(item('a')); manager.register(item('b'))
    def callback(value, context):
        seen.append(value.id)
        manager.register(item('c'))
        manager.remove('b')
    manager.on_trigger(callback)
    results = manager.evaluate_all({'value': [{'value': 20}]})
    assert [result.alert.id for result in results] == ['a', 'b']
    assert seen == ['a', 'b'] and manager.get('c').state == 'normal'


def test_copied_callback_context_expires_after_listener_returns(tmp_path):
    from contextvars import copy_context
    engine, watch = setup(tmp_path); contexts = []
    try:
        alert = watch.alerts.create(definition())
        watch.alerts.on_trigger(lambda *args: contexts.append(copy_context()))
        watch.alerts.trigger(alert['id']); watch.stop()
        with pytest.raises(RuntimeError, match='lifecycle is stopped'):
            contexts[0].run(watch.alerts.add_note, alert['id'], content='late', created_by='callback')
    finally: watch.stop(); engine.dispose()
