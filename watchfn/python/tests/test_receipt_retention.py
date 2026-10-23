import time
from concurrent.futures import ThreadPoolExecutor
import pytest
from sqlalchemy import select, update, delete
from test_pagerduty_dispatch import database, rule, drain
from test_alert_dispatch import endpoint
from test_durable_alerts import open_watch


def before():
    time.sleep(.002)
    return int(time.time() * 1000)


def complete(watch, identifier):
    watch.alerts.trigger(identifier)
    watch.alerts.acknowledge(identifier, acknowledged_by='operator')
    watch.alerts.resolve(identifier, resolved_by='operator')
    drain(watch)


def test_prune_keeps_current_tails_and_dismissed_blocked_chain_across_reopen(database, endpoint):
    path, engine, watch, tables, config = database
    identifier = watch.alerts.create(rule())['id']
    complete(watch, identifier)
    assert watch.alerts.prune_notifications(completed_before=before()) == {'scanned': 3, 'deleted': 2, 'pinned': 1, 'nextCursor': None}
    old_tail = watch.alerts.notifications()[0]['id']
    watch.stop(); engine.dispose()
    engine2, reopened = open_watch(path, alerts=config)
    try:
        endpoint[1]['drop'] = True
        complete(reopened, identifier)
        unknown = next(row for row in reopened.alerts.notifications() if row['outcome'] == 'unknown')
        reopened.alerts.reconcile_notification(unknown['id'], outcome='dismissed', actor='operator', reason='Explicit unresolved closure')
        result = reopened.alerts.prune_notifications(completed_before=before())
        assert (result['deleted'], result['pinned']) == (0, 2)
        assert old_tail in [row['id'] for row in reopened.alerts.notifications()]
        assert reopened.alerts.get_record(identifier)['pendingNotifications'] == 2
        assert len(endpoint[1]['requests']) == 4
    finally: reopened.stop(); engine2.dispose()


def test_migration_reopens_and_concurrent_operators_preserve_durable_progress(database, endpoint):
    path, engine, watch, tables, config = database
    identifier = watch.alerts.create(rule())['id']
    complete(watch, identifier)
    with engine.begin() as connection:
        connection.execute(update(tables['watchfn_alert_runtime']).values(protocol='python-v1'))
        connection.execute(update(tables['watchfn_alert_outbox']).values(predecessorId=None, completedAt=None))
    first = watch.alerts.migrate_receipt_retention(limit=1)
    assert first['phase'] == 'backfill' and first['processed'] == 1
    for action in [lambda: watch.alerts.create(rule()), lambda: watch.alerts.trigger(identifier), lambda: watch.alerts.process_notifications(), lambda: watch.alerts.prune_notifications(completed_before=before())]:
        with pytest.raises(RuntimeError, match='incompatible'): action()
    watch.stop(); engine.dispose()
    engine2, reopened = open_watch(path, alerts=config)
    engine3, other = open_watch(path, alerts=config)
    try:
        assert reopened.alerts.receipt_retention_status()['cursor'] == first['cursor']
        for _ in range(8):
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(worker.alerts.migrate_receipt_retention, limit=1) for worker in (reopened, other)]
                results = []
                for future in futures:
                    try: results.append(future.result())
                    except Exception as error:
                        # SQLite contention/CAS may reject one whole page; durable progress is retried by the host.
                        from watchfn import AlertConflict
                        from superfunctions.db import AdapterError
                        assert isinstance(error, (AlertConflict, AdapterError))
            if any(result['done'] for result in results): break
        assert reopened.alerts.receipt_retention_status()['protocol'] == 'python-v2'
        assert reopened.alerts.prune_notifications(completed_before=before())['deleted'] == 2
        assert len(endpoint[1]['requests']) == 3
    finally: reopened.stop(); other.stop(); engine2.dispose(); engine3.dispose()


def test_missing_dependency_prevents_activation_without_losing_progress(database):
    path, engine, watch, tables, config = database
    identifier = watch.alerts.create(rule())['id']
    watch.alerts.trigger(identifier); watch.alerts.resolve(identifier, resolved_by='operator')
    import json
    with engine.begin() as connection:
        rows = connection.execute(select(tables['watchfn_alert_outbox'])).mappings().all()
        trigger = next(row for row in rows if json.loads(row['payload'])['notification']['event'] == 'triggered')
        connection.execute(delete(tables['watchfn_alert_outbox']).where(tables['watchfn_alert_outbox'].c.id == trigger['id']))
        connection.execute(update(tables['watchfn_alert_runtime']).values(protocol='python-v1'))
    watch.alerts.migrate_receipt_retention(limit=1)
    status = watch.alerts.receipt_retention_status()
    with pytest.raises(ValueError, match='predecessor missing'): watch.alerts.migrate_receipt_retention(limit=1)
    assert watch.alerts.receipt_retention_status() == status
    with pytest.raises(RuntimeError, match='incompatible'): watch.alerts.process_notifications()


def test_competing_prune_and_trigger_keep_predecessor_and_exact_accounting(database, endpoint):
    path, engine, watch, tables, config = database
    identifier = watch.alerts.create(rule())['id']
    complete(watch, identifier)
    engine2, other = open_watch(path, alerts=config)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            prune = pool.submit(watch.alerts.prune_notifications, completed_before=before(), limit=1)
            trigger = pool.submit(other.alerts.trigger, identifier)
            # Independent SQLite writers may expose an atomic conflict; retry only the rejected DB-only operation.
            for future, retry in [(prune, lambda: watch.alerts.prune_notifications(completed_before=before(), limit=1)), (trigger, lambda: other.alerts.trigger(identifier))]:
                try: future.result()
                except Exception as error:
                    from watchfn import AlertConflict
                    from superfunctions.db import AdapterError
                    assert isinstance(error, (AlertConflict, AdapterError))
                    retry()
        drain(other)
        for worker in (watch, other):
            after = None
            for _ in range(8):
                result = worker.alerts.prune_notifications(completed_before=before(), limit=1, after=after)
                after = result['nextCursor']
                if after is None: break
        assert len(watch.alerts.notifications()) == 1
        assert watch.alerts.get_record(identifier)['pendingNotifications'] == 0
        assert len(endpoint[1]['requests']) == 4
    finally: other.stop(); engine2.dispose()


def test_invalid_projection_never_deletes_receipt(database):
    path, engine, watch, tables, config = database
    identifier = watch.alerts.create(rule())['id']
    watch.alerts.trigger(identifier); drain(watch)
    with engine.begin() as connection:
        connection.execute(update(tables['watchfn_alert_outbox']).values(completedAt=1))
    with pytest.raises(ValueError, match='projection'): watch.alerts.prune_notifications(completed_before=before())
    assert len(watch.alerts.notifications()) == 1


def test_committed_page_survives_killed_native_worker(database):
    import json
    import os
    from pathlib import Path
    import subprocess
    import sys
    path, engine, watch, tables, config = database
    identifier = watch.alerts.create(rule())['id']
    watch.alerts.trigger(identifier); watch.alerts.resolve(identifier, resolved_by='operator')
    with engine.begin() as connection:
        connection.execute(update(tables['watchfn_alert_runtime']).values(protocol='python-v1'))
    code = "import os,signal,json; from test_durable_alerts import open_watch; engine,watch=open_watch(" + repr(path) + "); result=watch.alerts.migrate_receipt_retention(limit=1); print(json.dumps(result),flush=True); os.kill(os.getpid(),signal.SIGKILL)"
    child = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=10, env={**os.environ, 'PYTHONPATH': str(Path(__file__).parent)})
    assert child.returncode == -9, child.stderr
    saved = json.loads(child.stdout)
    assert saved['phase'] == 'backfill'
    assert watch.alerts.receipt_retention_status()['cursor'] == saved['cursor']
    for _ in range(8):
        if watch.alerts.migrate_receipt_retention(limit=1)['done']: break
    assert watch.alerts.receipt_retention_status()['protocol'] == 'python-v2'
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 2


@pytest.mark.parametrize('mode', ['missing', 'rollback'])
def test_delete_capability_or_failure_never_partially_changes_accounting(database, monkeypatch, mode):
    from superfunctions_sqlalchemy.adapter import SQLAlchemyTransactionAdapter
    path, engine, watch, tables, config = database
    identifier = watch.alerts.create(rule())['id']; complete(watch, identifier)
    with engine.connect() as connection:
        initial = connection.execute(select(tables['watchfn_alerts'])).mappings().one()
        receipts = connection.execute(select(tables['watchfn_alert_outbox'])).mappings().all()
    original = SQLAlchemyTransactionAdapter.delete
    async def fail_after_delete(self, params):
        await original(self, params)
        raise RuntimeError('Owned rollback fixture')
    monkeypatch.setattr(SQLAlchemyTransactionAdapter, 'delete', None if mode == 'missing' else fail_after_delete)
    with pytest.raises(RuntimeError, match='transaction.delete|Owned rollback fixture'):
        watch.alerts.prune_notifications(completed_before=before())
    with engine.connect() as connection:
        assert connection.execute(select(tables['watchfn_alerts'])).mappings().one() == initial
        assert connection.execute(select(tables['watchfn_alert_outbox'])).mappings().all() == receipts


def test_tied_timestamp_and_long_identity_pagination(database, endpoint):
    import json
    path, engine, watch, tables, config = database
    value = rule(); value['channels'] = [{'type': 'webhook', 'webhook': endpoint[0]}]
    identifier = watch.alerts.create(value)['id']
    for _ in range(3):
        watch.alerts.trigger(identifier); watch.alerts.resolve(identifier, resolved_by='operator')
    drain(watch)
    with engine.begin() as connection:
        rows = connection.execute(select(tables['watchfn_alert_outbox'])).mappings().all()
        for index, row in enumerate(rows):
            identity = '東京' * 100 + str(index)
            payload = json.loads(row['payload']); payload['notification']['id'] = identity; payload['delivery']['completedAt'] = 123
            connection.execute(update(tables['watchfn_alert_outbox']).where(tables['watchfn_alert_outbox'].c.id == row['id']).values(id=identity, payload=json.dumps(payload), completedAt=None))
        connection.execute(update(tables['watchfn_alert_runtime']).values(protocol='python-v1'))
    longest = 0
    for _ in range(20):
        result = watch.alerts.migrate_receipt_retention(limit=1)
        longest = max(longest, len(result['cursor'] or ''))
        if result['done']: break
    assert longest > 128
    after, deleted = None, 0
    for _ in range(10):
        result = watch.alerts.prune_notifications(completed_before=before(), limit=1, after=after)
        deleted += result['deleted']; after = result['nextCursor']
        if after is None: break
    assert deleted == 6 and watch.alerts.notifications() == []
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 0


def test_schema_indexes_support_bounded_native_ranges(database):
    _, engine, _, _, _ = database
    queries = [
        ('SELECT id FROM watchfn_alert_outbox WHERE namespace=? AND completedAt>? AND completedAt<? ORDER BY completedAt,id LIMIT 5', ('database', 0, 100), 'watchfn_alert_receipts'),
        ('SELECT id FROM watchfn_alert_outbox WHERE namespace=? AND predecessorId=? LIMIT 1', ('database', 'owned'), 'watchfn_alert_predecessor'),
        ('SELECT id FROM watchfn_alert_outbox WHERE namespace=? AND id>? ORDER BY id LIMIT 6', ('database', 'owned'), 'watchfn_alert_jobs'),
        ('SELECT id FROM watchfn_alerts WHERE namespace=? AND id>? ORDER BY id LIMIT 6', ('database', 'owned'), 'watchfn_alert_namespace'),
    ]
    with engine.connect() as connection:
        for query, params, index in queries:
            plan = [row[-1] for row in connection.exec_driver_sql('EXPLAIN QUERY PLAN ' + query, params)]
            assert any(index in detail for detail in plan)
            assert not any('USE TEMP B-TREE' in detail for detail in plan)
