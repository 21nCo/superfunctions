"""Owned SES Query HTTP acceptance; no AWS/provider service calls."""

import asyncio
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

import pytest

from sendfn.email.aws_ses import AwsSesProvider
from sendfn.email.provider import SendEmailRequest
from sendfn.errors import EmailProviderError
from sendfn.models import AwsSesConfig


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


def request():
    return SendEmailRequest(
        from_email="sender@example.invalid",
        to=["recipient@example.invalid"],
        subject="Owned notification",
        html="<p>Owned body</p>",
        text="Owned body",
    )


@pytest.mark.asyncio
async def test_real_query_request_single_attempt_and_client_close(endpoint):
    config, state, entered, release = endpoint
    provider = AwsSesProvider(config)
    try:
        response = await provider.send_email(request())
        assert response.success and response.provider_message_id == "owned-message-id"
        assert provider._client.meta.config.retries["total_max_attempts"] == 1
        assert provider._client.meta.config.connect_timeout == 1.0
        assert provider._client.meta.config.read_timeout == 2.0
        assert state["requests"][0]["Action"] == ["SendEmail"]
        assert state["requests"][0]["Destination.ToAddresses.member.1"] == [
            "recipient@example.invalid"
        ]
        assert state["requests"][0]["Message.Subject.Data"] == ["Owned notification"]
        assert await provider.is_healthy()
    finally:
        await provider.close()
    assert provider.pending_operations == 0 and provider._client is None
    with pytest.raises(EmailProviderError, match="closing"):
        await provider.send_email(request())
    assert len(state["requests"]) == 2


@pytest.mark.asyncio
async def test_cancelled_send_stays_owned_and_cancelled_close_still_drains(endpoint):
    config, state, entered, release = endpoint
    provider = AwsSesProvider(config)
    await provider.initialize()
    release.clear()
    sending = asyncio.create_task(provider.send_email(request()))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        sending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await sending
        assert provider.pending_operations == 1
        closing = asyncio.create_task(provider.close())
        await asyncio.sleep(0.02)
        assert not closing.done()
        with pytest.raises(EmailProviderError, match="closing"):
            await provider.send_email(request())
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        assert provider.pending_operations == 1
        release.set()
        await provider.close()
        assert provider.pending_operations == 0 and len(state["requests"]) == 1
    finally:
        release.set()
        await provider.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("drop", [False, True])
async def test_read_timeout_or_lost_response_has_no_sdk_replay(endpoint, drop):
    config, state, entered, release = endpoint
    config.read_timeout = 0.1
    provider = AwsSesProvider(config)
    state["drop"] = drop
    if not drop:
        release.clear()
    try:
        response = await provider.send_email(request())
        assert response.success is False
        assert len(state["requests"]) == 1
        await provider.close()
        assert provider.pending_operations == 0
    finally:
        release.set()
        await provider.close()


@pytest.mark.asyncio
async def test_cancelled_initialization_remains_owned_until_close(endpoint, monkeypatch):
    config, state, entered, release = endpoint
    provider = AwsSesProvider(config)
    constructing, finish = threading.Event(), threading.Event()
    factory = provider._create_client
    closed = []

    def slow_factory():
        constructing.set()
        finish.wait(5)
        client = factory()
        close = client.close

        def tracked_close():
            close()
            closed.append(True)

        client.close = tracked_close
        return client

    monkeypatch.setattr(provider, "_create_client", slow_factory)
    opening = asyncio.create_task(provider.initialize())
    try:
        assert await asyncio.to_thread(constructing.wait, 2)
        opening.cancel()
        with pytest.raises(asyncio.CancelledError):
            await opening
        closing = asyncio.create_task(provider.close())
        await asyncio.sleep(0.02)
        assert not closing.done()
        finish.set()
        await closing
        assert closed == [True] and provider.pending_operations == 0
        assert not state["requests"]
    finally:
        finish.set()
        await provider.close()


@pytest.mark.parametrize("value", [0, -1, 121, float("inf"), True, "1"])
def test_invalid_socket_bounds_fail_before_client_creation(value):
    with pytest.raises(ValueError):
        AwsSesConfig(
            accessKeyId="key", secretAccessKey="secret", region="us-east-1", readTimeout=value
        )


@pytest.mark.parametrize(
    "value",
    ["file:///tmp/email", "https://user:pass@example.invalid", "https://example.invalid:bad"],
)
def test_invalid_endpoint_rejected(value):
    with pytest.raises(ValueError):
        AwsSesConfig(
            accessKeyId="key", secretAccessKey="secret", region="us-east-1", endpointUrl=value
        )


@pytest.mark.asyncio
async def test_failed_construction_retries_once_for_concurrent_callers(endpoint, monkeypatch):
    config, state, entered, release = endpoint
    provider = AwsSesProvider(config)
    started, finish = threading.Event(), threading.Event()
    factory = provider._create_client
    attempts = []

    def fail_once():
        attempts.append(True)
        if len(attempts) == 1:
            started.set()
            finish.wait(5)
            raise RuntimeError("temporary construction failure")
        return factory()

    monkeypatch.setattr(provider, "_create_client", fail_once)
    first = asyncio.create_task(provider.initialize())
    try:
        assert await asyncio.to_thread(started.wait, 2)
        second = asyncio.create_task(provider.initialize())
        await asyncio.sleep(0)
        finish.set()
        results = await asyncio.gather(first, second, return_exceptions=True)
        assert all(isinstance(result, RuntimeError) for result in results)
        assert len(attempts) == 1
        await asyncio.gather(provider.initialize(), provider.initialize())
        assert len(attempts) == 2
        assert (await provider.send_email(request())).success
        assert len(state["requests"]) == 1
    finally:
        finish.set()
        await provider.close()


@pytest.mark.asyncio
async def test_close_during_failed_construction_never_retries(endpoint, monkeypatch):
    config, state, entered, release = endpoint
    provider = AwsSesProvider(config)
    started, finish = threading.Event(), threading.Event()
    attempts = []

    def fail():
        attempts.append(True)
        started.set()
        finish.wait(5)
        raise RuntimeError("temporary construction failure")

    monkeypatch.setattr(provider, "_create_client", fail)
    opening = asyncio.create_task(provider.initialize())
    try:
        assert await asyncio.to_thread(started.wait, 2)
        closing = asyncio.create_task(provider.close())
        await asyncio.sleep(0)
        finish.set()
        with pytest.raises(RuntimeError, match="temporary"):
            await opening
        await closing
        with pytest.raises(EmailProviderError, match="closing"):
            await provider.initialize()
        assert len(attempts) == 1 and provider.pending_operations == 0
        assert not state["requests"]
    finally:
        finish.set()
        await provider.close()


@pytest.mark.asyncio
async def test_cancelled_close_consumes_detached_error_but_later_await_observes_it(
    endpoint, monkeypatch
):
    config, state, entered, release = endpoint
    provider = AwsSesProvider(config)
    await provider.initialize()
    started, finish = threading.Event(), threading.Event()
    original_close = provider._client.close
    observed = []
    consume = provider._consume_error

    def observe(task):
        observed.append(task)
        consume(task)

    def fail_close():
        started.set()
        finish.wait(5)
        original_close()
        raise RuntimeError("owned close failure")

    monkeypatch.setattr(provider._client, "close", fail_close)
    monkeypatch.setattr(provider, "_consume_error", observe)
    closing = asyncio.create_task(provider.close())
    try:
        assert await asyncio.to_thread(started.wait, 2)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        finish.set()
        with pytest.raises(RuntimeError, match="owned close failure"):
            await asyncio.wait_for(asyncio.shield(provider._close_task), timeout=2)
        await asyncio.sleep(0)
        assert provider._close_task in observed
        with pytest.raises(RuntimeError, match="owned close failure"):
            await provider.close()
        assert not state["requests"]
    finally:
        finish.set()
        await asyncio.gather(provider._close_task, return_exceptions=True)
