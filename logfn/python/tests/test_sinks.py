import asyncio
import datetime
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

import logfn.sinks
from logfn import MAX_EVENT_SIZE, SinkConsole, SinkHttp, create_logger
from logfn.types import LogEvent

URL = "https://logs.example.com/ingest"


def event(msg: str, **overrides: Any) -> LogEvent:
    data: dict[str, Any] = {"ts": "2026-01-14T12:00:00.000Z", "level": "info", "msg": msg, "name": "t", "version": "0"}
    data.update(overrides)
    return data  # type: ignore[return-value]


class Scripted:
    """Transport replying with a script of statuses, exceptions or "hang"."""

    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies) or [200]
        self.calls: list[tuple[str, dict[str, str], list[str]]] = []

    async def __call__(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        self.calls.append((url, headers, [e["msg"] for e in json.loads(body)["events"]]))
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if reply == "hang":
            await asyncio.sleep(3600)
        if isinstance(reply, BaseException):
            raise reply
        return int(reply)

    @property
    def batches(self) -> list[list[str]]:
        return [messages for _, _, messages in self.calls]


async def eventually(predicate: Any, timeout: float = 5.0) -> None:
    """Polls instead of sleeping a fixed time, so a loaded machine cannot reorder the check."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        assert asyncio.get_running_loop().time() < deadline, "condition not reached in time"
        await asyncio.sleep(0.005)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"url": "/ingest"}, "absolute http"),
        ({"url": "ftp://logs.example.com"}, "absolute http"),
        ({"url": "https://user:pw@logs.example.com"}, "must not contain credentials"),
        ({"url": URL, "batch_size": 0}, "batch_size"),
        ({"url": URL, "max_queue": 1.5}, "max_queue"),
        ({"url": URL, "retry_attempts": 0}, "retry_attempts"),
        ({"url": URL, "timeout": -1}, "timeout"),
        ({"url": URL, "timeout": 0}, "timeout must be a positive number"),
    ],
)
def test_rejects_invalid_configuration(kwargs: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        SinkHttp(**kwargs)


def test_no_request_without_events() -> None:
    transport = Scripted()
    sink = SinkHttp(URL, transport=transport)
    asyncio.run(sink.flush())
    assert transport.calls == []
    assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 0, "failed_batches": 0}


def test_full_batch_on_running_loop_and_interval_for_partial() -> None:
    transport = Scripted()

    async def scenario() -> None:
        sink = SinkHttp(URL, transport=transport, batch_size=3, flush_interval_ms=300)
        sink([event("1")])
        sink([event("2")])
        await asyncio.sleep(0)
        assert transport.calls == []
        sink([event("3")])
        await eventually(lambda: sink.stats()["sent"] == 3)
        assert transport.batches == [["1", "2", "3"]]
        started = asyncio.get_running_loop().time()
        sink([event("4")])
        await eventually(lambda: sink.stats()["sent"] == 4)
        assert asyncio.get_running_loop().time() - started >= 0.29
        assert transport.batches == [["1", "2", "3"], ["4"]]

    asyncio.run(scenario())


def test_without_a_loop_events_wait_for_flush_and_split_into_batches() -> None:
    transport = Scripted()
    sink = SinkHttp(URL, transport=transport, batch_size=2)
    sink([event("a"), event("b"), event("c")])
    assert transport.calls == []
    asyncio.run(sink.flush())
    assert transport.batches == [["a", "b"], ["c"]]


def test_headers_and_secret_header() -> None:
    bearer = Scripted()
    sink = SinkHttp(URL, auth_token="tok", headers={"X-Custom": "v"}, transport=bearer)
    sink([event("m")])
    asyncio.run(sink.flush())
    assert bearer.calls[0][1] == {"Content-Type": "application/json", "X-Custom": "v", "Authorization": "Bearer tok"}

    secret = Scripted()
    sink = SinkHttp(URL, auth_token="k-1", secret_header="X-API-Key", transport=secret)
    sink([event("m")])
    asyncio.run(sink.flush())
    assert secret.calls[0][1]["X-API-Key"] == "k-1" and "Authorization" not in secret.calls[0][1]


def test_queue_cap_drops_oldest() -> None:
    transport = Scripted()
    drops: list[tuple[int, str]] = []
    sink = SinkHttp(URL, transport=transport, batch_size=100, max_queue=3, on_drop=lambda n, r: drops.append((n, r)))
    for msg in "12345":
        sink([event(msg)])
    assert sink.stats()["queued"] == 3 and sink.stats()["dropped"] == 2
    assert drops == [(1, "queue_full"), (1, "queue_full")]
    asyncio.run(sink.flush())
    assert transport.batches == [["3", "4", "5"]]


def test_oversized_batch_prepares_only_the_newest_max_queue_events(monkeypatch: pytest.MonkeyPatch) -> None:
    prepared: list[str] = []
    original = logfn.sinks.sanitize_event

    def counting(value: LogEvent) -> LogEvent:
        prepared.append(value["msg"])
        return original(value)

    monkeypatch.setattr(logfn.sinks, "sanitize_event", counting)
    transport = Scripted()
    drops: list[tuple[int, str]] = []
    sink = SinkHttp(URL, transport=transport, batch_size=100, max_queue=3, on_drop=lambda n, r: drops.append((n, r)))
    sink([event(msg) for msg in "12345"])
    assert prepared == ["3", "4", "5"]
    assert drops == [(2, "queue_full")]
    asyncio.run(sink.flush())
    assert transport.batches == [["3", "4", "5"]]
    assert sink.stats()["dropped"] == 2


def test_bounded_while_collector_is_down() -> None:
    transport = Scripted(ConnectionRefusedError("refused"))
    errors: list[BaseException] = []

    async def scenario() -> SinkHttp:
        sink = SinkHttp(URL, transport=transport, batch_size=10, max_queue=25, retry_attempts=2, backoff_ms=1, on_error=errors.append)
        for i in range(1000):
            sink([event(str(i))])
            assert sink.stats()["queued"] <= 25
            if i % 50 == 0:
                await asyncio.sleep(0)
        await sink.flush()
        await sink.flush()
        return sink

    sink = asyncio.run(scenario())
    stats = sink.stats()
    assert stats["queued"] == 0 and stats["sent"] == 0 and stats["dropped"] == 1000
    assert errors


def test_retries_then_succeeds() -> None:
    transport = Scripted(503, 429, OSError("reset"), 200)
    sink = SinkHttp(URL, transport=transport, batch_size=1, backoff_ms=1)
    sink([event("m")])
    asyncio.run(sink.flush())
    assert len(transport.calls) == 4
    assert sink.stats()["sent"] == 1 and sink.stats()["dropped"] == 0


def test_client_error_is_not_retried() -> None:
    transport = Scripted(400)
    errors: list[BaseException] = []
    drops: list[tuple[int, str]] = []
    sink = SinkHttp(URL, transport=transport, on_error=errors.append, on_drop=lambda n, r: drops.append((n, r)))
    sink([event("m")])
    asyncio.run(sink.flush())
    assert len(transport.calls) == 1
    assert str(errors[0]) == "HTTP 400"
    assert drops == [(1, "delivery_failed")]
    assert sink.stats()["failed_batches"] == 1


def test_each_attempt_times_out() -> None:
    transport = Scripted("hang", "hang", 200)
    sink = SinkHttp(URL, transport=transport, timeout=0.05, retry_attempts=3, backoff_ms=1)
    sink([event("m")])
    asyncio.run(sink.flush())
    assert len(transport.calls) == 3 and sink.stats()["sent"] == 1


def test_failures_never_reach_the_caller() -> None:
    def explode(*args: Any) -> None:
        raise RuntimeError("handler broke")

    async def broken(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        raise RuntimeError("boom")

    sink = SinkHttp(URL, transport=broken, retry_attempts=1, max_queue=1, on_error=explode, on_drop=explode)
    sink([event("1"), event("2")])
    sink("not a batch")  # type: ignore[arg-type]
    asyncio.run(sink.flush())
    assert sink.stats()["dropped"] == 2


def test_flush_waits_for_in_flight_then_sends_the_rest() -> None:
    release = asyncio.Event
    batches: list[list[str]] = []

    async def scenario() -> SinkHttp:
        gate = release()

        async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
            batches.append([e["msg"] for e in json.loads(body)["events"]])
            if len(batches) == 1:
                await gate.wait()
            return 200

        sink = SinkHttp(URL, transport=transport, batch_size=1, timeout=60)
        sink([event("first")])
        await asyncio.sleep(0.01)
        assert sink.stats()["in_flight"] == 1
        sink([event("second")])
        flushing = asyncio.ensure_future(sink.flush())
        await asyncio.sleep(0)
        gate.set()
        await flushing
        return sink

    sink = asyncio.run(scenario())
    assert batches == [["first"], ["second"]]
    assert sink.stats()["sent"] == 2 and sink.stats()["queued"] == 0


def _gated_then(*replies: int) -> tuple[Any, list[list[str]], Any]:
    # The first request waits for the returned gate; later ones reply in order.
    gate: dict[str, asyncio.Event] = {}
    batches: list[list[str]] = []
    rest = list(replies)

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        batches.append([e["msg"] for e in json.loads(body)["events"]])
        if len(batches) == 1:
            await gate.setdefault("first", asyncio.Event()).wait()
            return 200
        return rest.pop(0) if len(rest) > 1 else rest[0]

    def release() -> None:
        gate.setdefault("first", asyncio.Event()).set()

    return transport, batches, release


def test_flush_settles_events_handed_to_the_next_drain() -> None:
    transport, batches, release = _gated_then(200)

    async def scenario() -> dict[str, int]:
        sink = SinkHttp(URL, transport=transport, batch_size=2, flush_interval_ms=60_000, timeout=60)
        sink([event("1"), event("2")])
        await eventually(lambda: sink.stats()["in_flight"] == 2)
        sink([event("3"), event("4")])
        flushing = asyncio.ensure_future(sink.flush())
        await asyncio.sleep(0)
        release()
        await flushing
        return sink.stats()

    stats = asyncio.run(scenario())
    assert stats == {"queued": 0, "in_flight": 0, "sent": 4, "dropped": 0, "failed_batches": 0}
    assert batches == [["1", "2"], ["3", "4"]]


def test_close_settles_a_handed_over_batch_through_retries() -> None:
    transport, batches, release = _gated_then(503, 200)
    errors: list[BaseException] = []

    async def scenario() -> dict[str, int]:
        sink = SinkHttp(
            URL, transport=transport, batch_size=2, flush_interval_ms=60_000, timeout=60, backoff_ms=10, on_error=errors.append
        )
        sink([event("1"), event("2")])
        await eventually(lambda: sink.stats()["in_flight"] == 2)
        sink([event("3"), event("4")])
        closing = asyncio.ensure_future(sink.close())
        await asyncio.sleep(0)
        release()
        await closing
        return sink.stats()

    stats = asyncio.run(scenario())
    assert stats == {"queued": 0, "in_flight": 0, "sent": 4, "dropped": 0, "failed_batches": 0}
    assert batches == [["1", "2"], ["3", "4"], ["3", "4"]] and errors == []


def test_closed_sink_drops_what_a_cancelled_drain_held_or_left_queued() -> None:
    transport = Scripted("hang")
    drops: list[tuple[int, str]] = []
    sink = SinkHttp(URL, transport=transport, batch_size=2, timeout=60, on_drop=lambda n, r: drops.append((n, r)))

    async def scenario() -> None:
        sink([event("a"), event("b")])
        await eventually(lambda: sink.stats()["in_flight"] == 2)
        sink([event("c")])
        asyncio.ensure_future(sink.close())
        await asyncio.sleep(0)

    asyncio.run(scenario())  # asyncio.run cancels the hanging drain and close on exit
    assert sink.stats()["queued"] == 0 and sink.stats()["dropped"] == 3
    assert drops == [(3, "closed")]


def test_close_flushes_then_drops() -> None:
    transport = Scripted()
    drops: list[tuple[int, str]] = []
    sink = SinkHttp(URL, transport=transport, on_drop=lambda n, r: drops.append((n, r)))
    sink([event("before")])
    asyncio.run(sink.close())
    sink([event("after")])
    asyncio.run(sink.flush())
    assert transport.batches == [["before"]]
    assert drops == [(1, "closed")]


def test_batch_prepared_while_close_runs_is_dropped_not_queued() -> None:
    # A thread paused inside event preparation (after the entry check) while
    # close() completes must not queue the event behind the final flush.
    preparing, resume = threading.Event(), threading.Event()

    class SlowDate(datetime.date):
        def isoformat(self) -> str:
            preparing.set()
            resume.wait(5)
            return super().isoformat()

    transport = Scripted(204)
    drops: list[tuple[int, str]] = []
    sink = SinkHttp(URL, batch_size=1, transport=transport, on_drop=lambda n, r: drops.append((n, r)))
    late = threading.Thread(target=lambda: sink([event("late", ctx={"day": SlowDate(2020, 1, 1)})]))
    late.start()
    assert preparing.wait(5)
    asyncio.run(sink.close())
    resume.set()
    late.join(5)
    assert transport.batches == []
    assert drops == [(1, "closed")]
    assert sink.stats()["queued"] == 0


def test_queues_redacted_copies() -> None:
    transport = Scripted()
    sink = SinkHttp(URL, transport=transport)
    original = event("token=abc", ctx={"password": "pw"})
    sink([original])
    asyncio.run(sink.flush())
    assert original == event("token=abc", ctx={"password": "pw"})
    assert transport.batches == [["token=[redacted]"]]


@pytest.fixture
def collector() -> Iterator[tuple[str, list[dict[str, Any]], list[str]]]:
    received: list[dict[str, Any]] = []
    auth: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.extend(json.loads(body)["events"])
            auth.append(self.headers.get("Authorization", ""))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/ingest", received, auth
    finally:
        server.shutdown()
        server.server_close()


def test_default_transport_posts_to_a_real_collector(collector: tuple[str, list[dict[str, Any]], list[str]]) -> None:
    url, received, auth = collector
    sink = SinkHttp(url, auth_token="tok", batch_size=2)
    logger = create_logger("real", sinks=[sink])
    logger.info("one", api_key="k-1")
    logger.info("two")
    asyncio.run(logger.flush())
    assert [e["msg"] for e in received] == ["one", "two"]
    assert received[0]["ctx"] == {"api_key": "[redacted]"}
    assert auth == ["Bearer tok"]


def test_console_sink_json(capsys: pytest.CaptureFixture[str]) -> None:
    SinkConsole(json=True)([event("hello", ctx={"a": 1})])
    assert json.loads(capsys.readouterr().out) == event("hello", ctx={"a": 1})
    SinkConsole(json=False, color=False)([event("hi", ctx={"a": 1})])
    assert capsys.readouterr().out.strip() == "[2026-01-14T12:00:00.000Z] INFO (t): hi a=1"


def test_console_sink_bounds_each_event_itself(capsys: pytest.CaptureFixture[str]) -> None:
    # Loggers pass events without a size bound; the sink applies it.
    logger = create_logger("t", sinks=[SinkConsole(json=True)], level="info")
    logger.info("€" * 40_000, blob="x" * 70_000)
    line = capsys.readouterr().out.strip()
    assert len(line.encode()) <= MAX_EVENT_SIZE
    printed = json.loads(line)
    assert printed["ctx"]["_truncated"] is True
    assert printed["msg"].endswith("...[truncated]")


def test_events_survive_a_finished_event_loop() -> None:
    transport = Scripted()
    sink = SinkHttp(URL, transport=transport, batch_size=10, flush_interval_ms=20)

    async def queue_without_flush(msg: str) -> None:
        sink([event(msg)])

    asyncio.run(queue_without_flush("first"))  # leaves a timer on a closed loop

    async def second_loop() -> None:
        sink([event("second")])
        await eventually(lambda: sink.stats()["sent"] == 2)

    asyncio.run(second_loop())
    assert transport.batches == [["first", "second"]]


def test_cancelled_drain_keeps_its_batch() -> None:
    transport = Scripted("hang", 200)

    async def cancelled() -> None:
        sink([event("kept")])
        await asyncio.sleep(0.01)
        assert sink.stats()["in_flight"] == 1

    sink = SinkHttp(URL, transport=transport, batch_size=1, timeout=60)
    asyncio.run(cancelled())  # asyncio.run cancels the hanging drain on exit
    assert sink.stats()["queued"] == 1 and sink.stats()["dropped"] == 0
    asyncio.run(sink.flush())
    assert transport.batches == [["kept"], ["kept"]] and sink.stats()["sent"] == 1


def test_event_logged_while_flush_awaits_in_flight_is_sent_after_the_interval() -> None:
    batches: list[list[str]] = []

    async def scenario() -> SinkHttp:
        gate = asyncio.Event()

        async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
            batches.append([e["msg"] for e in json.loads(body)["events"]])
            if len(batches) == 1:
                await gate.wait()
            return 200

        sink = SinkHttp(URL, transport=transport, batch_size=10, flush_interval_ms=50, timeout=60)
        sink([event("first")])
        flushing = asyncio.ensure_future(sink.flush())
        await eventually(lambda: sink.stats()["in_flight"] == 1)
        sink([event("during flush")])
        gate.set()
        await flushing
        assert batches == [["first"]]
        await eventually(lambda: sink.stats()["sent"] == 2)
        return sink

    sink = asyncio.run(scenario())
    assert batches == [["first"], ["during flush"]] and sink.stats()["queued"] == 0


def test_cancelled_drain_requeues_within_max_queue() -> None:
    transport = Scripted("hang", 200)
    drops: list[tuple[int, str]] = []

    async def cancelled() -> None:
        sink([event("a"), event("b")])
        await eventually(lambda: sink.stats()["in_flight"] == 2)
        sink([event("c"), event("d")])
        assert sink.stats()["queued"] == 2

    sink = SinkHttp(URL, transport=transport, batch_size=2, max_queue=2, timeout=60, on_drop=lambda n, r: drops.append((n, r)))
    asyncio.run(cancelled())  # asyncio.run cancels the hanging drain on exit
    assert sink.stats()["queued"] == 2 and sink.stats()["dropped"] == 2
    assert drops == [(2, "queue_full")]
    asyncio.run(sink.flush())
    assert transport.batches[-1] == ["c", "d"]


def test_direct_call_sends_only_redacted_json_safe_fields() -> None:
    class Leaky:
        def __str__(self) -> str:
            return "access_token=STR_SECRET Bearer BEARER_SECRET"

    transport = Scripted()
    bodies: list[bytes] = []

    async def capture(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return await transport(url, body, headers, timeout)

    sink = SinkHttp(URL, transport=capture, batch_size=1)
    sink(
        [
            event(
                "m",
                ctx={"response": Leaky(), "raw": b"password=BYTES_SECRET", "https://u:KEYPW@h.test": 1},
                tags=[{"token": "TAG_SECRET"}],
                userId={"password": "USER_SECRET"},
                requestId="access_token=REQ_SECRET",
                extra={"password": "EXTRA_SECRET"},
            )
        ]
    )
    asyncio.run(sink.flush())
    assert len(bodies) == 1
    for secret in (b"STR_SECRET", b"BEARER_SECRET", b"BYTES_SECRET", b"KEYPW", b"TAG_SECRET", b"USER_SECRET", b"REQ_SECRET", b"EXTRA_SECRET"):
        assert secret not in bodies[0]
    sent = json.loads(bodies[0])["events"][0]
    assert sent["ctx"] == {"response": "[unserializable]", "raw": "[unserializable]", "https://[redacted]@h.test": 1}
    assert sent["userId"] == {"password": "[redacted]"} and sent["extra"] == {"password": "[redacted]"}


def test_direct_call_bounds_each_event() -> None:
    bodies: list[bytes] = []

    async def capture(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    sink = SinkHttp(URL, transport=capture, batch_size=1)
    sink([event("m", name="n" * 70_000, requestId="r" * 70_000)])
    asyncio.run(sink.flush())
    sent = json.loads(bodies[0])["events"][0]
    assert len(json.dumps(sent, ensure_ascii=False, separators=(",", ":")).encode()) <= MAX_EVENT_SIZE


def test_request_body_is_encoded_as_measured_by_the_size_limit() -> None:
    bodies: list[bytes] = []

    async def capture(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    sink = SinkHttp(URL, transport=capture, batch_size=1)
    sink([event("€" * 15_000), event("€" * 40_000)])
    asyncio.run(sink.flush())
    envelope = len(b'{"events":[]}')
    assert len(bodies) == 2
    for body in bodies:
        assert len(body) <= MAX_EVENT_SIZE + envelope
        assert b"\\u20ac" not in body
    assert json.loads(bodies[0])["events"][0]["msg"] == "€" * 15_000


def _server(status: int, location: str | None, received: list[dict[str, Any]]) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def _handle(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            received.append({"method": self.command, "headers": dict(self.headers), "body": self.rfile.read(length)})
            self.send_response(status)
            if location:
                self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_GET = do_POST = _handle

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
    return server


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
@pytest.mark.parametrize("secret_header", [None, "X-Api-Key"])
def test_default_transport_does_not_follow_redirects(status: int, secret_header: str | None) -> None:
    elsewhere: list[dict[str, Any]] = []
    first: list[dict[str, Any]] = []
    other = _server(204, None, elsewhere)
    collector = _server(status, f"http://127.0.0.1:{other.server_address[1]}/steal", first)
    errors: list[BaseException] = []
    drops: list[tuple[int, str]] = []
    try:
        sink = SinkHttp(
            f"http://127.0.0.1:{collector.server_address[1]}/ingest",
            auth_token="COLLECTOR_TOKEN",
            secret_header=secret_header,
            batch_size=1,
            retry_attempts=3,
            backoff_ms=1,
            on_error=errors.append,
            on_drop=lambda n, r: drops.append((n, r)),
        )
        sink([event("redirected")])
        asyncio.run(sink.flush())
    finally:
        for server in (collector, other):
            server.shutdown()
            server.server_close()
    assert len(first) == 1 and first[0]["method"] == "POST"
    assert elsewhere == []
    assert [str(error) for error in errors] == [f"HTTP {status}: redirects are not followed"]
    assert drops == [(1, "delivery_failed")]
    assert sink.stats()["sent"] == 0 and sink.stats()["failed_batches"] == 1

