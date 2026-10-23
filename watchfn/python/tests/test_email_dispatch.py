from concurrent.futures import ThreadPoolExecutor
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
import pytest
from sendfn.models import AwsSesConfig
from watchfn.models import AlertDeliveryConfig
from test_database import migrate
from test_durable_alerts import migrate_alerts, open_watch, definition

@pytest.fixture
def endpoint():
    entered, release = threading.Event(), threading.Event()
    release.set()
    state = {"requests": [], "drop": False}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = parse_qs(self.rfile.read(int(self.headers["content-length"])).decode())
            state["requests"].append(body)
            entered.set()
            release.wait(5)
            if state["drop"]:
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            if body["Action"] == ["GetSendQuota"]:
                action, result = (
                    "GetSendQuota",
                    "<Max24HourSend>200</Max24HourSend><MaxSendRate>1</MaxSendRate><SentLast24Hours>0</SentLast24Hours>",
                )
            else:
                action, result = "SendEmail", "<MessageId>owned-message-id</MessageId>"
            response = (
                f'<{action}Response xmlns="http://ses.amazonaws.com/doc/2010-12-01/">'
                f"<{action}Result>{result}</{action}Result>"
                f"<ResponseMetadata><RequestId>owned-request</RequestId></ResponseMetadata></{action}Response>"
            ).encode()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/xml")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    config = AwsSesConfig(
        accessKeyId="owned-local-key",
        secretAccessKey="owned-local-secret",
        region="us-east-1",
        endpointUrl=f"http://127.0.0.1:{server.server_port}",
        connectTimeout=1.0,
        readTimeout=2.0,
    )
    try:
        yield config, state, entered, release
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture
def database(tmp_path, endpoint):
    ses, state, entered, release = endpoint
    path = 'sqlite:///' + str(tmp_path / 'email.sqlite')
    config = {'email': {'fromEmail': 'sender@example.com', 'awsSes': ses.model_dump()}}
    engine, watch = open_watch(path, alerts=config)
    migrate(engine); migrate_alerts(engine)
    try: yield path, engine, watch, config
    finally: release.set(); watch.stop(); engine.dispose()


def rule():
    value = definition()
    value['channels'] = [{'type': 'email', 'recipients': ['recipient@example.com']}]
    value['description'] = '<script>untrusted</script>'
    return value


def test_real_ses_acceptance_reopen_two_workers_and_private_config(database, endpoint, monkeypatch):
    path, engine, watch, config = database
    ses, state, entered, release = endpoint
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    # Queue is persisted before any provider construction or send.
    assert not state['requests']
    watch.stop(); engine.dispose()
    first_engine, first = open_watch(path, alerts=config)
    second_engine, second = open_watch(path, alerts=config)
    from superfunctions_sqlalchemy.adapter import SQLAlchemyTransactionAdapter
    find_one = SQLAlchemyTransactionAdapter.find_one
    barrier = threading.Barrier(2)
    async def simultaneous_first_read(self, params):
        row = await find_one(self, params)
        if params.model == 'watchfn_alert_runtime' and row is None:
            barrier.wait(timeout=3)
        return row
    monkeypatch.setattr(SQLAlchemyTransactionAdapter, 'find_one', simultaneous_first_read)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda w: w.alerts.process_notifications(), [first, second]))
        assert len(state['requests']) == 1
        body = state['requests'][0]
        assert body['Destination.ToAddresses.member.1'] == ['recipient@example.com']
        assert '&lt;script&gt;' in body['Message.Body.Html.Data'][0]
        assert first.alerts.get_record(identifier)['pendingNotifications'] == 0
        public = json.dumps([first.alerts.notifications(), first.alerts.list(), AlertDeliveryConfig(**config).model_dump()])
        assert 'owned-local-secret' not in public and 'recipient@example.com' not in public
        assert first.alerts.notifications()[0]['outcome'] == 'delivered'
    finally:
        first.stop(); second.stop(); first_engine.dispose(); second_engine.dispose()


def test_lost_response_is_unknown_and_never_replayed(database, endpoint):
    path, engine, watch, config = database
    ses, state, entered, release = endpoint; state['drop'] = True
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    watch.alerts.process_notifications()
    assert len(state['requests']) == 1
    job = watch.alerts.notifications()[0]
    assert job['outcome'] == 'unknown'
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 1
    watch.stop(); engine.dispose()
    other_engine, other = open_watch(path, alerts=config)
    try:
        other.alerts.process_notifications()
        assert len(state['requests']) == 1
        other.alerts.reconcile_notification(job['id'], outcome='delivered', actor='operator', reason='SES acceptance independently verified')
        assert other.alerts.get_record(identifier)['pendingNotifications'] == 0
    finally: other.stop(); other_engine.dispose()


def test_timeout_and_stop_wait_for_actual_worker_drain(database, endpoint):
    path, engine, watch, config = database
    ses, state, entered, release = endpoint; release.clear()
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    with ThreadPoolExecutor(max_workers=2) as pool:
        operation = pool.submit(watch.alerts.process_notifications, timeout_ms=250, lease_ms=500)
        try:
            assert entered.wait(2)
            time.sleep(.6)  # Beyond both caller deadline and durable lease.
            assert not operation.done()
            stopped = pool.submit(watch.stop)
            time.sleep(.05)
            assert not stopped.done()
        finally: release.set()
        operation.result(timeout=3); stopped.result(timeout=3)
    assert len(state['requests']) == 1
    other_engine, other = open_watch(path, alerts=config)
    try:
        other.alerts.process_notifications()
        job = other.alerts.notifications()[0]
        assert job['outcome'] == 'unknown' and job['attempts'] == 1
        assert other.alerts.get_record(identifier)['pendingNotifications'] == 1
        assert len(state['requests']) == 1
    finally: other.stop(); other_engine.dispose()


def test_unconfigured_sender_preserves_unclaimed_obligation(database, endpoint):
    path, engine, watch, config = database
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    watch.stop(); engine.dispose()
    other_engine, other = open_watch(path)
    try:
        assert other.alerts.process_notifications()['processed'] == 0
        assert other.alerts.notifications()[0]['attempts'] == 0
        assert other.alerts.get_record(identifier)['pendingNotifications'] == 1
        assert not endpoint[1]['requests']
    finally: other.stop(); other_engine.dispose()


def test_malformed_recipient_fails_before_claim(database, endpoint):
    path, engine, watch, config = database
    value = rule(); value['channels'][0]['recipients'] = ['bad\r\nBcc: injected@example.com']
    identifier = watch.alerts.create(value)['id']; watch.alerts.trigger(identifier)
    with pytest.raises(ValueError, match='Invalid email recipients'):
        watch.alerts.process_notifications()
    assert watch.alerts.notifications()[0]['attempts'] == 0
    assert not endpoint[1]['requests']


def test_timeout_during_client_close_retains_operation(database, endpoint, monkeypatch):
    from sendfn.email.aws_ses import AwsSesProvider
    original = AwsSesProvider._create_client
    closing, finish = threading.Event(), threading.Event()
    def client_with_blocked_close(self):
        client = original(self)
        close = client.close
        def blocked_close():
            closing.set(); finish.wait(5); close()
        client.close = blocked_close
        return client
    monkeypatch.setattr(AwsSesProvider, '_create_client', client_with_blocked_close)
    path, engine, watch, config = database
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    with ThreadPoolExecutor(max_workers=2) as pool:
        operation = pool.submit(watch.alerts.process_notifications, timeout_ms=250, lease_ms=500)
        try:
            assert closing.wait(2)
            time.sleep(.6)
            assert not operation.done()
            stopped = pool.submit(watch.stop)
            time.sleep(.05)
            assert not stopped.done()
        finally: finish.set()
        operation.result(timeout=3); stopped.result(timeout=3)
    assert len(endpoint[1]['requests']) == 1


def test_failed_client_cleanup_surfaces_without_secret_or_success(database, endpoint, monkeypatch):
    from sendfn.email.aws_ses import AwsSesProvider
    original = AwsSesProvider._create_client
    def client_with_failed_close(self):
        client = original(self)
        close = client.close
        def failed_close():
            close(); raise RuntimeError('owned-local-secret')
        client.close = failed_close
        return client
    monkeypatch.setattr(AwsSesProvider, '_create_client', client_with_failed_close)
    path, engine, watch, config = database
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    with pytest.raises(RuntimeError, match='^SES provider cleanup incomplete$'):
        watch.alerts.process_notifications()
    job = watch.alerts.notifications()[0]
    assert job['state'] == 'sending' and job['attempts'] == 1
    assert watch.alerts.get_record(identifier)['pendingNotifications'] == 1
    assert len(endpoint[1]['requests']) == 1


@pytest.mark.parametrize('kind', ['duplicate-without-marker', 'unexpected'])
def test_marker_failure_does_not_admit_email(database, endpoint, monkeypatch, kind):
    from superfunctions.db import AdapterError, DuplicateKeyError
    from superfunctions_sqlalchemy.adapter import SQLAlchemyTransactionAdapter
    create = SQLAlchemyTransactionAdapter.create
    async def failed_marker(self, params):
        if params.model == 'watchfn_alert_runtime':
            if kind == 'duplicate-without-marker': raise DuplicateKeyError('owned marker collision')
            raise AdapterError('private error must not be swallowed')
        return await create(self, params)
    monkeypatch.setattr(SQLAlchemyTransactionAdapter, 'create', failed_marker)
    path, engine, watch, config = database
    identifier = watch.alerts.create(rule())['id']; watch.alerts.trigger(identifier)
    with pytest.raises(RuntimeError, match='ownership could not be verified|storage operation failed'):
        watch.alerts.process_notifications()
    assert not endpoint[1]['requests']
    assert watch.alerts.notifications()[0]['attempts'] == 0


@pytest.mark.parametrize('email', [
    {'fromEmail': 'sender@example.com'},
    {'fromEmail': 'bad\nfrom@example.com', 'awsSes': {}},
    {'fromEmail': 'sender@example.com', 'awsSes': {'accessKeyId': 'owned', 'secretAccessKey': 'owned', 'region': 'us-east-1', 'readTimeout': 0}},
])
def test_invalid_host_configuration_fails_before_client_creation(email, monkeypatch):
    from sendfn.email.aws_ses import AwsSesProvider
    def unexpected(self): raise AssertionError('client must not be constructed')
    monkeypatch.setattr(AwsSesProvider, '_create_client', unexpected)
    with pytest.raises(ValueError, match='Invalid trusted SES email configuration'):
        AlertDeliveryConfig(email=email)


def test_provider_capability_is_required_before_dispatch_configuration(endpoint, monkeypatch):
    from sendfn.email.aws_ses import AwsSesProvider
    monkeypatch.delattr(AwsSesProvider, 'pending_operations')
    with pytest.raises(ValueError, match='operation-ownership prerequisite'):
        AlertDeliveryConfig(email={'fromEmail': 'sender@example.com', 'awsSes': endpoint[0].model_dump()})
    assert not endpoint[1]['requests']
