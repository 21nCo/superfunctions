from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import threading
import time

import pytest
from sqlalchemy import select
from watchfn import AlertConflict
from test_database import migrate
from test_durable_alerts import migrate_alerts, open_watch, definition


@pytest.fixture
def endpoint():
    state = {'requests': [], 'status': 200, 'drop': False, 'delay': 0, 'body': b'ok', 'retry_after': '60'}
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received = {'key': self.headers.get('idempotency-key'), 'body': json.loads(self.rfile.read(int(self.headers['content-length'])))}
            state['requests'].append(received)
            if state['delay']: time.sleep(state['delay'])
            if state['drop']:
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            try:
                self.send_response(state['status'])
                if state['status'] == 429: self.send_header('Retry-After', state['retry_after'])
                body = json.dumps({'status': 'success', 'dedup_key': received['body'].get('dedup_key')}).encode() if state.get('pagerduty') else state['body']
                self.end_headers(); self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever); thread.start()
    try: yield 'http://127.0.0.1:' + str(server.server_port) + '/private-token', state
    finally: server.shutdown(); server.server_close(); thread.join()


@pytest.fixture
def database(tmp_path):
    path = 'sqlite:///' + str(tmp_path / 'dispatch.sqlite')
    engine, watch = open_watch(path)
    migrate(engine); tables = migrate_alerts(engine)
    try: yield path, engine, watch, tables
    finally: watch.stop(); engine.dispose()


def enqueue(watch, url, kind='webhook'):
    value = definition(); value['channels'] = [{'type': kind, 'webhook': url}]
    record = watch.alerts.create(value)
    watch.alerts.trigger(record['id'])
    return record['id']


def test_http_receipt_reopen_no_replay_and_no_routing_credentials(database, endpoint):
    path, engine, watch, tables = database
    url, state = endpoint
    identifier = enqueue(watch, url)
    assert watch.alerts.process_notifications()['processed'] == 1
    assert len(state['requests']) == 1
    item = watch.alerts.notifications()[0]
    assert item['outcome'] == 'delivered' and item['state'] == 'dead'
    assert state['requests'][0]['key'] == item['id']
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 0
    with engine.connect() as connection:
        payload = connection.execute(select(tables['watchfn_alert_outbox'].c.payload)).scalar_one()
        assert 'private-token' not in payload
    second_engine, second = open_watch(path)
    try:
        assert second.alerts.process_notifications()['processed'] == 0
        assert len(state['requests']) == 1
        assert second.alerts.notifications()[0]['outcome'] == 'delivered'
        assert second.alerts.reconcile_notification(item['id'], outcome='delivered', actor='operator', reason='already verified') is False
    finally: second.stop(); second_engine.dispose()


def test_lost_response_is_parked_not_retried_and_operator_reconciles(database, endpoint):
    path, engine, watch, tables = database
    url, state = endpoint; state['drop'] = True
    identifier = enqueue(watch, url)
    assert watch.alerts.process_notifications()['processed'] == 1
    item = watch.alerts.notifications()[0]
    assert item['outcome'] == 'unknown' and item['state'] == 'dead'
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 1
    second_engine, second = open_watch(path)
    try:
        second.alerts.process_notifications()
        assert len(state['requests']) == 1
        assert second.alerts.reconcile_notification(item['id'], outcome='delivered', actor='operator', reason='Provider receipt verified') is True
        assert watch.alerts.get_record(identifier)['pendingNotifications'] == 0
        assert second.alerts.reconcile_notification(item['id'], outcome='delivered', actor='operator', reason='duplicate') is False
    finally: second.stop(); second_engine.dispose()


def test_two_workers_send_once_and_expired_claim_never_replays(database, endpoint):
    path, engine, watch, tables = database
    url, state = endpoint
    watch.alerts.process_notifications()  # Acquire namespace before racing job claims.
    identifier = enqueue(watch, url)
    second_engine, second = open_watch(path)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda worker: worker.alerts.process_notifications(), [watch, second]))
        assert sum(result['processed'] for result in results) == 1
        assert len(state['requests']) == 1
        other = enqueue(watch, url)
        with engine.begin() as connection:
            table = tables['watchfn_alert_outbox']
            connection.execute(table.update().where(table.c.alertId == other).values(state='sending', leaseToken='lost-worker', availableAt=0, attempts=1))
        second.alerts.process_notifications()
        assert len(state['requests']) == 1
        unknown = [item for item in watch.alerts.notifications() if item['alertId'] == other][0]
        assert unknown['outcome'] == 'unknown'
        assert watch.alerts.get_record(other)['pendingNotifications'] == 1
    finally: second.stop(); second_engine.dispose()


def test_slack_rate_limit_backoff_and_bounded_retry_exhaustion(database, endpoint):
    path, engine, watch, tables = database
    url, state = endpoint; state['status'] = 429
    identifier = enqueue(watch, url, 'slack')
    watch.alerts.process_notifications(max_attempts=2)
    item = watch.alerts.notifications()[0]
    assert item['state'] == 'pending' and item['attempts'] == 1
    with engine.connect() as connection:
        available = connection.execute(select(tables['watchfn_alert_outbox'].c.availableAt)).scalar_one()
        assert available > int(time.time() * 1000) + 50000
    watch.alerts.process_notifications(max_attempts=2)
    assert len(state['requests']) == 1
    with engine.begin() as connection:
        connection.execute(tables['watchfn_alert_outbox'].update().values(availableAt=0))
    watch.alerts.process_notifications(max_attempts=2)
    item = watch.alerts.notifications()[0]
    assert item['state'] == 'dead' and item['outcome'] == 'rejected' and item['attempts'] == 2
    assert len(state['requests']) == 2
    assert state['requests'][0]['key'] == state['requests'][1]['key']
    assert state['requests'][0]['body'] == {'text': '[warning] slow: triggered'}
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 1
    watch.alerts.reconcile_notification(item['id'], outcome='dismissed', actor='operator', reason='Delivery cancelled')
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 0


def test_timeout_is_unknown_and_errors_do_not_escape(database, endpoint):
    path, engine, watch, tables = database
    url, state = endpoint; state['delay'] = .25; state['body'] = b'private-provider-body'
    enqueue(watch, url)
    began = time.monotonic()
    result = watch.alerts.process_notifications(timeout_ms=50, lease_ms=500)
    assert time.monotonic() - began < 2
    assert result['processed'] == 1
    assert watch.alerts.notifications()[0]['outcome'] == 'unknown'
    assert 'private' not in json.dumps(watch.alerts.notifications())
    count = len(state['requests'])
    assert count <= 1  # The whole-operation deadline can expire before I/O begins.
    watch.alerts.process_notifications()
    assert len(state['requests']) == count


def test_missing_sender_does_not_claim_and_foreign_protocol_fails_closed(database):
    path, engine, watch, tables = database
    value = definition(); value['channels'] = [{'type': 'email', 'recipients': ['owner@example.invalid']}]
    identifier = watch.alerts.create(value)['id']; watch.alerts.trigger(identifier)
    watch.alerts.process_notifications()
    item = watch.alerts.notifications()[0]
    assert item['attempts'] == 0 and item['state'] == 'pending'
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 1
    with engine.begin() as connection:
        connection.execute(tables['watchfn_alert_runtime'].update().values(protocol='ts-v1'))
    with pytest.raises(RuntimeError, match='incompatible'): watch.alerts.process_notifications()
    with pytest.raises(RuntimeError, match='incompatible'):
        watch.alerts.reconcile_notification(item['id'], outcome='dismissed', actor='operator', reason='test')
    assert watch.alerts.notifications()[0]['attempts'] == 0


def test_stop_drains_bounded_send_and_keeps_unknown_obligation(database, endpoint):
    path, engine, watch, tables = database
    url, state = endpoint; state['delay'] = .5
    identifier = enqueue(watch, url)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(lambda: watch.alerts.process_notifications(timeout_ms=150, lease_ms=1000))
        deadline = time.monotonic() + 5
        while not state['requests'] and time.monotonic() < deadline: time.sleep(.005)
        assert len(state['requests']) == 1
        watch.stop()
        assert future.result(timeout=5)['processed'] == 1
    second_engine, second = open_watch(path)
    try:
        assert second.alerts.notifications()[0]['outcome'] == 'unknown'
        assert second.alerts.get_record(identifier)['pendingNotifications'] == 1
        second.alerts.process_notifications()
        assert len(state['requests']) == 1
    finally: second.stop(); second_engine.dispose()


def test_cursor_traversal_reaches_http_behind_unconfigured_jobs(database, endpoint):
    path, engine, watch, tables = database
    url, state = endpoint
    for _ in range(2):
        value = definition(); value['channels'] = [{'type': 'email', 'recipients': ['owner@example.invalid']}]
        identifier = watch.alerts.create(value)['id']; watch.alerts.trigger(identifier)
    enqueue(watch, url)
    cursor = None
    for _ in range(4):
        result = watch.alerts.process_notifications(limit=1, after=cursor)
        cursor = result['nextCursor']
        if cursor is None: break
    assert cursor is None
    assert len(state['requests']) == 1
    assert sorted(item['attempts'] for item in watch.alerts.notifications()) == [0, 0, 1]


def test_foreign_protocol_blocks_actual_http_job_before_claim(database, endpoint):
    path, engine, watch, tables = database
    url, state = endpoint
    identifier = enqueue(watch, url)
    with engine.begin() as connection:
        connection.execute(tables['watchfn_alert_runtime'].update().values(protocol='ts-v2'))
    with pytest.raises(RuntimeError, match='incompatible'): watch.alerts.process_notifications()
    assert not state['requests']
    assert watch.alerts.notifications()[0]['attempts'] == 0
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 1


def test_provider_success_with_failed_receipt_commit_keeps_lease_and_no_replay(database, endpoint):
    from superfunctions.db import AdapterError
    path, engine, watch, tables = database
    url, state = endpoint
    identifier = enqueue(watch, url)
    storage = watch.alerts.storage
    transaction = storage.db.transaction
    failed = False
    async def fail_receipt(action):
        nonlocal failed
        if state['requests'] and not failed:
            failed = True
            raise AdapterError('private SQL parameters and credentials')
        return await transaction(action)
    storage.db.transaction = fail_receipt
    try:
        with pytest.raises(RuntimeError, match='^Alert storage operation failed$'):
            watch.alerts.process_notifications()
    finally: storage.db.transaction = transaction
    assert failed and len(state['requests']) == 1
    assert watch.alerts.notifications()[0]['state'] == 'sending'
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 1
    with engine.begin() as connection:
        connection.execute(tables['watchfn_alert_outbox'].update().values(availableAt=0))
    second_engine, second = open_watch(path)
    try:
        second.alerts.process_notifications()
        item = second.alerts.notifications()[0]
        assert item['outcome'] == 'unknown'
        assert len(state['requests']) == 1
        second.alerts.reconcile_notification(item['id'], outcome='delivered', actor='operator', reason='Receipt independently confirmed')
        assert second.alerts.get_record(identifier)['pendingNotifications'] == 0
    finally: second.stop(); second_engine.dispose()


def test_foreign_protocol_fences_lifecycle_creation_and_mutation(database):
    path, engine, watch, tables = database
    identifier = watch.alerts.create(definition())['id']
    before = watch.alerts.get_record(identifier)
    with engine.begin() as connection:
        connection.execute(tables['watchfn_alert_runtime'].update().values(protocol='ts-v2'))
    for action in [lambda: watch.alerts.create(definition()), lambda: watch.alerts.trigger(identifier),
                   lambda: watch.alerts.add_note(identifier, content='note', created_by='operator')]:
        with pytest.raises(RuntimeError, match='incompatible dispatch protocol'): action()
    assert watch.alerts.get_record(identifier) == before
    assert watch.alerts.notifications() == []
