import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import BigInteger, Column, MetaData, String, Table, Text, Index, create_engine, select, func
from superfunctions_sqlalchemy import create_adapter
from watchfn import WatchFn, AlertConflict, get_alert_schema
from watchfn.alerts.alert_manager import Alert
from test_database import migrate, start


def migrate_alerts(engine):
    metadata = MetaData()
    tables = {}
    for schema in get_alert_schema().values():
        tables[schema.name] = Table(schema.name, metadata, *[Column(field.name, Text if field.type == 'text' else BigInteger if field.type == 'bigint' else String, primary_key=field.primary_key, nullable=field.nullable, unique=field.unique) for field in schema.fields])
        for index in schema.indexes or []:
            Index(index.name, *[tables[schema.name].c[field] for field in index.fields], unique=index.unique)
    metadata.create_all(engine)
    return tables


def definition(**extra):
    return dict(name='slow', condition={'metric': 'api.latency', 'operator': 'gt', 'threshold': 10, 'window': '5m'}, channels=[{'type': 'webhook', 'webhook': 'https://example.invalid/private-token'}], **extra)


def open_watch(path, namespace='database', **kwargs):
    engine = create_engine(path)
    adapter = create_adapter(engine)
    watch = WatchFn(namespace, storage='database', database=adapter, **kwargs)
    watch.system_metrics.start = lambda: None
    watch.process_metrics.start = lambda: None
    watch.start()
    return engine, watch


def test_lifecycle_outbox_reopen_and_no_channel_secrets(tmp_path):
    path = 'sqlite:///' + str(tmp_path / 'alerts.sqlite')
    engine, watch = open_watch(path)
    migrate(engine); tables = migrate_alerts(engine)
    try:
        record = watch.alerts.create(definition())
        assert record['channels'] == [{'type': 'webhook', 'configured': True}]
        identifier = record['id']
        watch.track('api', {'latency': 20})
        assert watch.alerts.evaluate_stored()[0].matched is True
        watch.alerts.acknowledge(identifier, acknowledged_by='operator', note='Investigating')
        assert watch.alerts.get(identifier).state == 'acknowledged'
        assert len(watch.alerts.notifications()) == 2
        assert 'private-token' not in json.dumps(watch.alerts.list())
        assert 'private-token' not in json.dumps(watch.alerts.notifications())
    finally: watch.stop(); engine.dispose()
    engine, watch = open_watch(path)
    try:
        restored = watch.alerts.get_record(identifier)
        assert restored['state'] == 'acknowledged' and restored['notes'][0]['content'] == 'Investigating'
        watch.alerts.resolve(identifier, resolved_by='operator', resolution='Fixed')
        assert watch.alerts.get(identifier).state == 'resolved'
        assert len(watch.alerts.notifications()) == 3
        watch.alerts.resolve(identifier, resolved_by='operator')
        assert len(watch.alerts.notifications()) == 3
        with engine.connect() as connection:
            rows = connection.execute(select(tables['watchfn_alert_outbox'])).mappings().all()
            assert all(row['state'] == 'pending' and row['attempts'] == 0 for row in rows)
            assert {json.loads(row['payload'])['notification']['event'] for row in rows} == {'triggered', 'acknowledged', 'resolved'}
    finally: watch.stop(); engine.dispose()


def test_register_identical_does_not_reset_and_update_replaces_metadata(tmp_path):
    engine, watch = open_watch('sqlite:///' + str(tmp_path / 'alerts.sqlite'))
    migrate(engine); migrate_alerts(engine)
    try:
        item = Alert('stable', 'slow', None, True, definition()['condition'], 'warning', [])
        watch.alerts.register(item); watch.alerts.trigger('stable'); watch.alerts.register(item)
        assert watch.alerts.get('stable').state == 'triggered'
        item.name = 'changed'
        with pytest.raises(AlertConflict): watch.alerts.register(item)
        record = watch.alerts.create(definition(description='old', autoResolve={'enabled': True, 'condition': definition()['condition']}))
        replacement = watch.alerts.update(record['id'], definition())
        assert 'description' not in replacement and 'autoResolve' not in replacement
    finally: watch.stop(); engine.dispose()


def test_atomic_outbox_failure_rolls_back_state_and_capacity(tmp_path):
    engine, watch = open_watch('sqlite:///' + str(tmp_path / 'alerts.sqlite'))
    migrate(engine); tables = migrate_alerts(engine)
    try:
        record = watch.alerts.create(definition())
        original = watch.storage.db.transaction
        async def failing(callback):
            async def wrap(tx):
                create = tx.create
                async def broken(params):
                    if params.model == 'watchfn_alert_outbox': raise RuntimeError('owned failure')
                    return await create(params)
                tx.create = broken
                return await callback(tx)
            return await original(wrap)
        watch.storage.db.transaction = failing
        with pytest.raises(RuntimeError, match='owned failure'): watch.alerts.trigger(record['id'])
        watch.storage.db.transaction = original
        assert watch.alerts.get_record(record['id'])['state'] == 'normal'
        assert watch.alerts.notifications() == []
        watch.alerts.max_pending = 1
        watch.alerts.trigger(record['id'])
        with pytest.raises(ValueError, match='capacity'): watch.alerts.acknowledge(record['id'], acknowledged_by='operator')
        assert watch.alerts.get_record(record['id'])['state'] == 'triggered'
        assert len(watch.alerts.notifications()) == 1
    finally: watch.stop(); engine.dispose()


def test_missing_atomic_extension_fails_before_definition_write(tmp_path):
    engine, watch = open_watch('sqlite:///' + str(tmp_path / 'alerts.sqlite'))
    migrate(engine); tables = migrate_alerts(engine)
    original = watch.storage.db.transaction
    async def unsupported(callback):
        async def wrap(tx):
            tx.update_many = None
            return await callback(tx)
        return await original(wrap)
    watch.storage.db.transaction = unsupported
    try:
        with pytest.raises(RuntimeError, match='atomic'): watch.alerts.create(definition())
        with engine.connect() as conn: assert conn.execute(select(func.count()).select_from(tables['watchfn_alerts'])).scalar_one() == 0
    finally: watch.stop(); engine.dispose()


def test_independent_workers_stale_observation_cannot_duplicate_outbox(tmp_path):
    path = 'sqlite:///' + str(tmp_path / 'alerts.sqlite')
    engine, first = open_watch(path)
    migrate(engine); migrate_alerts(engine)
    other_engine, second = open_watch(path)
    try:
        record = first.alerts.create(definition())
        first.track('api', {'latency': 20}); first.batcher.flush()
        ready = threading.Barrier(2)
        for watch in [first, second]:
            original = watch.alerts.snapshot
            def snapshot(requested, now, maximum, original=original):
                value = original(requested, now, maximum)
                ready.wait(timeout=5)
                return value
            watch.alerts.snapshot = snapshot
        # Use retained event time so observations are nonempty for both workers.
        now = first.query()[0].timestamp.replace(tzinfo=__import__('datetime').timezone.utc).timestamp() * 1000 + 10
        def run(watch):
            try: return watch.alerts.evaluate_stored(now=now)[0].matched
            except AlertConflict: return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool: outcomes = list(pool.map(run, [first, second]))
        assert outcomes.count(True) == 1 and outcomes.count('conflict') == 1
        assert first.alerts.get_record(record['id'])['pendingNotifications'] == 1
        assert len(first.alerts.notifications()) == 1
    finally: first.stop(); second.stop(); engine.dispose(); other_engine.dispose()


def test_namespace_fence_and_stop(tmp_path):
    path = 'sqlite:///' + str(tmp_path / 'alerts.sqlite')
    engine, watch = open_watch(path)
    migrate(engine); migrate_alerts(engine)
    second_engine, second = open_watch(path, 'other')
    try:
        record = watch.alerts.create(definition())
        assert second.alerts.get(record['id']) is None
        assert second.alerts.list() == []
        with pytest.raises(KeyError): second.alerts.trigger(record['id'])
        watch.stop()
        with pytest.raises(RuntimeError, match='not running'): watch.alerts.list()
    finally: watch.stop(); second.stop(); engine.dispose(); second_engine.dispose()



def test_ambiguous_commit_retry_does_not_duplicate_notification(tmp_path):
    engine, watch = open_watch('sqlite:///' + str(tmp_path / 'alerts.sqlite'))
    migrate(engine); migrate_alerts(engine)
    try:
        record = watch.alerts.create(definition())
        original = watch.storage.db.transaction
        async def ambiguous(callback):
            result = await original(callback)
            raise RuntimeError('lost completion')
        watch.storage.db.transaction = ambiguous
        with pytest.raises(RuntimeError, match='lost completion'): watch.alerts.trigger(record['id'])
        watch.storage.db.transaction = original
        watch.alerts.trigger(record['id'])
        assert len(watch.alerts.notifications()) == 1
        assert watch.alerts.get_record(record['id'])['pendingNotifications'] == 1
    finally: watch.stop(); engine.dispose()


def test_adapter_constraint_error_does_not_expose_channel_credentials(tmp_path):
    path = 'sqlite:///' + str(tmp_path / 'alerts.sqlite')
    engine, watch = open_watch(path)
    migrate(engine); migrate_alerts(engine)
    other_engine, other = open_watch(path, 'other')
    item = Alert('global-id', 'slow', None, True, definition()['condition'], 'warning', definition()['channels'])
    try:
        watch.alerts.register(item)
        with pytest.raises(RuntimeError) as failure: other.alerts.register(item)
        assert str(failure.value) == 'Alert storage operation failed'
        assert 'private-token' not in str(failure.value)
        assert other.alerts.list() == []
    finally: watch.stop(); other.stop(); engine.dispose(); other_engine.dispose()


def test_event_only_database_does_not_require_alert_namespace_or_tables(tmp_path):
    engine, watch = open_watch('sqlite:///' + str(tmp_path / 'events.sqlite'), 'x' * 129)
    migrate(engine)
    try:
        watch.track('event', {'value': 1})
        assert len(watch.query()) == 1
        with pytest.raises(ValueError, match='namespace'): _ = watch.alerts
    finally: watch.stop(); engine.dispose()



def test_public_channel_names_cannot_be_re_registered_as_configuration(tmp_path):
    engine, watch = open_watch('sqlite:///' + str(tmp_path / 'alerts.sqlite'))
    migrate(engine); migrate_alerts(engine)
    try:
        record = watch.alerts.create(definition())
        public = watch.alerts.get(record['id'])
        assert public.channels == ['webhook']
        with pytest.raises(ValueError, match='trusted full channel'): watch.alerts.register(public)
        assert watch.alerts.get_record(record['id'])['state'] == 'normal'
    finally: watch.stop(); engine.dispose()


@pytest.mark.parametrize('corruption', [
    {'notes': [{'content': 'x', 'createdBy': 123, 'createdAt': 1}]},
    {'pendingNotifications': 1001}, {'pendingNotifications': True}, {'createdAt': 'yesterday'},
])
def test_stored_corruption_fails_without_lifecycle_mutation(tmp_path, corruption):
    engine, watch = open_watch('sqlite:///' + str(tmp_path / 'alerts.sqlite'))
    migrate(engine); tables = migrate_alerts(engine)
    try:
        record = watch.alerts.create(definition())
        with engine.begin() as connection:
            table = tables['watchfn_alerts']
            row = connection.execute(select(table)).mappings().one()
            value = json.loads(row['payload']); value.update(corruption)
            connection.execute(table.update().values(payload=json.dumps(value)))
        with pytest.raises(ValueError, match='stored'): watch.alerts.trigger(record['id'])
        assert watch.alerts.notifications() == []
    finally: watch.stop(); engine.dispose()


def test_calculated_transition_context_survives_reopen(tmp_path):
    from datetime import datetime, timezone
    from watchfn import Event
    path = 'sqlite:///' + str(tmp_path / 'context.sqlite')
    engine, watch = open_watch(path)
    migrate(engine); tables = migrate_alerts(engine)
    try:
        condition = definition()['condition']
        record = watch.alerts.create(definition(autoResolve={'enabled': True, 'condition': dict(condition, operator='lt', threshold=2, window='1s')}))
        def sample(value, when):
            watch.storage.add(Event(type='track', name='api', properties={'latency': value}, timestamp=datetime.fromtimestamp(when / 1000, timezone.utc)))
        sample(20, 1000000); sample(40, 1000000)
        result = watch.alerts.evaluate_stored(now=1000000)[0]
        assert result.value == 30 and result.matched is True
        sample(0, 1010000)
        watch.alerts.evaluate_stored(now=1010000)
        assert watch.alerts.get_record(record['id'])['state'] == 'resolved'
    finally: watch.stop(); engine.dispose()
    engine, watch = open_watch(path)
    try:
        with engine.connect() as connection:
            notifications = [json.loads(row['payload'])['notification'] for row in connection.execute(select(tables['watchfn_alert_outbox'])).mappings()]
        by_event = {item['event']: item for item in notifications}
        assert (by_event['triggered']['value'], by_event['triggered']['threshold']) == (30, 10)
        assert (by_event['resolved']['value'], by_event['resolved']['threshold']) == (0, 2)
    finally: watch.stop(); engine.dispose()
