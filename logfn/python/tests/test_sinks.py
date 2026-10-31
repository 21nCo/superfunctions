import asyncio
import contextlib
import decimal
import json
import os
import socket
import threading
import time
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
        # Ports that are not a number from 1 to 65535 are rejected up front;
        # port 0 is never rewritten to the scheme's default port.
        ({"url": "http://c:abc/x"}, "absolute http"),
        ({"url": "http://c:0/x"}, "absolute http"),
        ({"url": "http://c:99999/x"}, "absolute http"),
        ({"url": URL, "batch_size": 0}, "batch_size"),
        ({"url": URL, "max_queue": 1.5}, "max_queue"),
        ({"url": URL, "retry_attempts": 0}, "retry_attempts"),
        ({"url": URL, "timeout": -1}, "timeout"),
        ({"url": URL, "timeout": 0}, "timeout must be a finite positive number"),
        # Infinite limits would leave a batch, and so flush() and close(), unbounded.
        ({"url": URL, "timeout": float("inf")}, "timeout must be a finite"),
        ({"url": URL, "timeout": float("nan")}, "timeout must be a finite"),
        ({"url": URL, "backoff_ms": float("inf")}, "backoff_ms must be a finite"),
        ({"url": URL, "flush_interval_ms": float("inf")}, "flush_interval_ms must be a finite"),
        ({"url": URL, "backoff_ms": 1e308, "retry_attempts": 3}, "unbounded retry budget"),
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
    assert sorted(drops) == [(1, "closed"), (2, "closed")]


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

    class SlowError(Exception):
        def __str__(self) -> str:
            preparing.set()
            resume.wait(5)
            return "slow"

    transport = Scripted(204)
    drops: list[tuple[int, str]] = []
    sink = SinkHttp(URL, batch_size=1, transport=transport, on_drop=lambda n, r: drops.append((n, r)))
    late = threading.Thread(target=lambda: sink([event("late", ctx={"error": SlowError()})]))
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


def test_header_values_are_trimmed_as_fetch_trims_them(collector: tuple[str, list[dict[str, Any]], list[str]]) -> None:
    url, received, auth = collector
    errors: list[BaseException] = []
    sink = SinkHttp(url, auth_token="tok\n", retry_attempts=1, on_error=errors.append)
    sink([event("m")])
    asyncio.run(sink.flush())
    assert auth == ["Bearer tok"] and [e["msg"] for e in received] == ["m"] and errors == []

    custom = Scripted()
    sink = SinkHttp(URL, headers={"Cookie": " \tc=1\r\n"}, auth_token="\tk-1 ", secret_header="X-Api-Key", transport=custom)
    sink([event("m")])
    asyncio.run(sink.flush())
    assert custom.calls[0][1] == {"Content-Type": "application/json", "Cookie": "c=1", "X-Api-Key": "k-1"}


SECRET = "S3CRET-VALUE"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"auth_token": f"{SECRET}\r\nX-Injected: 1"},
        {"auth_token": f"{SECRET}\0"},
        {"auth_token": f"{SECRET}\u20ac"},
        {"auth_token": f"{SECRET}\nx", "secret_header": "X-Api-Key"},
        {"headers": {"X-Api-Key": f"{SECRET}\r\nx"}},
        {"headers": {"Cookie": f"a={SECRET}\u0100"}},
        {"headers": {"Authorization": f"Bearer {SECRET}\nx"}},
        {"headers": {"X-Api-Key": 12345}},
        {"headers": {f"X-Key: {SECRET}": "v"}},
        {"auth_token": SECRET, "secret_header": "X Api Key"},
    ],
)
def test_unsendable_headers_fail_construction_without_their_values(
    kwargs: dict[str, Any], capsys: pytest.CaptureFixture[str]
) -> None:
    errors: list[BaseException] = []
    with pytest.raises(ValueError, match="^SinkHttp: header") as raised:
        SinkHttp(URL, retry_attempts=1, on_error=errors.append, **kwargs)
    reported = [raised.value, raised.value.__cause__, raised.value.__context__]
    assert all(SECRET not in repr(error) and "12345" not in repr(error) for error in reported)
    assert SECRET not in "".join(capsys.readouterr()) and errors == []


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


def test_float_tags_are_delivered_as_javascript_writes_numbers(capsys: pytest.CaptureFixture[str]) -> None:
    values = [1e-6, 1e-7, 2.5e-5, 1.5e21, 1e21, 123456789012345680000.0]
    expected = ["0.000001", "1e-7", "0.000025", "1.5e+21", "1e+21", "123456789012345680000"]
    bodies: list[bytes] = []

    async def capture(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    http = SinkHttp(URL, transport=capture, batch_size=1)
    logger = create_logger("svc", sinks=[http, SinkConsole(json=True)])
    logger.info("m", tags=values)  # type: ignore[arg-type]
    asyncio.run(http.flush())
    assert json.loads(bodies[0])["events"][0]["tags"] == expected
    assert json.loads(capsys.readouterr().out)["tags"] == expected


def test_float_tags_are_delivered_whatever_the_decimal_context() -> None:
    delivered: list[list[LogEvent]] = []
    errors: list[BaseException] = []
    logger = create_logger("svc", sinks=[delivered.append], on_error=lambda error, _event: errors.append(error))
    with decimal.localcontext(decimal.Context(prec=2, traps=[decimal.Inexact, decimal.Rounded])):
        logger.info("m", tags=[1.2345, 123456789.0, 0.30000000000000004])  # type: ignore[arg-type]
    assert errors == []
    assert [batch[0]["tags"] for batch in delivered] == [["1.2345", "123456789", "0.30000000000000004"]]


def test_direct_call_keeps_keys_that_sanitize_to_the_same_text() -> None:
    bodies: list[dict[str, Any]] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(json.loads(body))
        return 204

    sink = SinkHttp(URL, transport=transport)
    sink([event("ids", ctx={"by_id": {1: "numeric", "1": "text"}})])
    asyncio.run(sink.close())
    assert bodies[0]["events"][0]["ctx"] == {"by_id": {"1": "numeric", "1#2": "text"}}


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



def test_console_json_line_is_encoded_as_measured_by_the_size_limit(capsys: pytest.CaptureFixture[str]) -> None:
    SinkConsole(json=True)([event("€" * 15_000)])
    line = capsys.readouterr().out.rstrip("\n")
    assert len(line.encode()) <= MAX_EVENT_SIZE
    assert json.loads(line)["msg"] == "€" * 15_000


class ThreadGate:
    """A transport whose requests wait for a threading.Event, on any loop."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.waiting = threading.Semaphore(0)
        self.posted: list[list[str]] = []

    async def __call__(self, url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        self.waiting.release()
        while not self.release.is_set():
            await asyncio.sleep(0.005)
        self.posted.append([e["msg"] for e in json.loads(body)["events"]])
        return 204

    def wait_for_requests(self, count: int) -> None:
        for _ in range(count):
            assert self.waiting.acquire(timeout=5), "request not started"


def _in_thread(target: Any) -> threading.Thread:
    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    return thread


@pytest.mark.parametrize("method", ["flush", "close"])
def test_flush_and_close_wait_for_a_batch_another_loop_is_sending(method: str) -> None:
    gate = ThreadGate()
    sink = SinkHttp(URL, transport=gate, timeout=30)
    sink([event("held")])
    worker = _in_thread(lambda: asyncio.run(sink.flush()))
    gate.wait_for_requests(1)
    assert sink.stats()["in_flight"] == 1

    threading.Timer(0.2, gate.release.set).start()
    asyncio.run(getattr(sink, method)())
    # Returned only after the other loop's batch was sent, not before.
    assert gate.posted == [["held"]]
    assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 1, "dropped": 0, "failed_batches": 0}
    worker.join(5)


class _ReleaseHook:
    """A lock that runs a hook on the given thread after its nth release."""

    def __init__(self, lock: Any, thread: int, nth: int, hook: Any) -> None:
        self._lock, self._thread, self._left, self._hook = lock, thread, nth, hook

    def __enter__(self) -> None:
        self._lock.acquire()

    def __exit__(self, *_exc: object) -> None:
        self._lock.release()
        if threading.get_ident() == self._thread:
            self._left -= 1
            if self._left == 0:
                self._hook()


def test_flush_waits_for_a_batch_another_loop_puts_back_while_it_checks() -> None:
    # Another loop is sending the only event when flush() starts. Right after
    # flush() has found the queue empty, that loop's drain is cancelled and
    # puts the batch back. flush() must still see the event (now queued) and
    # send it, not find it neither queued nor in flight and return.
    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        if threading.current_thread() is other:
            await asyncio.sleep(3600)
        return 204

    sink = SinkHttp(URL, transport=transport, batch_size=1, timeout=30)
    other_loop = asyncio.new_event_loop()
    other = threading.Thread(target=other_loop.run_forever, daemon=True)
    other.start()
    try:
        other_loop.call_soon_threadsafe(sink, [event("moved")])
        deadline = time.monotonic() + 5
        while sink.stats()["in_flight"] != 1:
            assert time.monotonic() < deadline
            time.sleep(0.005)

        def put_back() -> None:
            drain = sink._drains[other_loop]
            other_loop.call_soon_threadsafe(drain.cancel)
            while sink.stats()["queued"] != 1:
                assert time.monotonic() < deadline + 5
                time.sleep(0.005)

        # Releases in flush(): the target read, then the queue check.
        sink._lock = _ReleaseHook(sink._lock, threading.get_ident(), 2, put_back)  # type: ignore[assignment]
        asyncio.run(sink.flush())
        assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 1, "dropped": 0, "failed_batches": 0}
    finally:
        other_loop.call_soon_threadsafe(other_loop.stop)
        other.join(5)
        other_loop.close()


def test_concurrent_drains_on_two_loops_account_for_every_batch() -> None:
    gate = ThreadGate()
    sink = SinkHttp(URL, transport=gate, batch_size=2, timeout=30)

    async def send_and_flush(*messages: str) -> None:
        sink([event(message) for message in messages])
        await sink.flush()

    workers = [_in_thread(lambda: asyncio.run(send_and_flush("a", "b"))), _in_thread(lambda: asyncio.run(send_and_flush("c", "d")))]
    gate.wait_for_requests(2)
    assert sink.stats()["in_flight"] == 4 and sink.stats()["queued"] == 0
    gate.release.set()
    for worker in workers:
        worker.join(5)
    assert sorted(gate.posted) == [["a", "b"], ["c", "d"]]
    assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 4, "dropped": 0, "failed_batches": 0}


def test_close_drops_a_batch_whose_loop_stopped_after_its_retry_budget() -> None:
    gate = ThreadGate()
    drops: list[tuple[int, str]] = []
    errors: list[BaseException] = []
    sink = SinkHttp(
        URL, transport=gate, batch_size=1, timeout=0.05, retry_attempts=1, on_drop=lambda n, r: drops.append((n, r)), on_error=errors.append
    )
    stopped = asyncio.new_event_loop()

    async def start_sending() -> None:
        sink([event("stranded")])
        await eventually(lambda: sink.stats()["in_flight"] == 1)

    try:
        # The drain is left pending on a loop that no longer runs.
        stopped.run_until_complete(start_sending())
        started = time.monotonic()
        asyncio.run(sink.close())
        elapsed = time.monotonic() - started
        assert 0.5 < elapsed < 5
        assert drops == [(1, "closed")] and len(errors) == 1
        assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 1, "failed_batches": 0}
        # The owner resuming later does not count the batch a second time.
        gate.release.set()
        stopped.run_until_complete(asyncio.sleep(0.1))
        assert sink.stats()["dropped"] == 1 and sink.stats()["sent"] == 0
    finally:
        for task in asyncio.all_tasks(stopped):
            task.cancel()
        stopped.run_until_complete(asyncio.sleep(0))
        stopped.close()


@pytest.mark.parametrize(("held", "abortable"), [(True, True), (False, True), (False, False)])
def test_a_batch_dropped_by_close_on_another_loop_gets_no_further_attempt(
    held: bool, abortable: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The owner loop stops during the first attempt; close() on another loop
    # drops the batch once its retry budget passes. held: the attempt only ends
    # when cancelled. Otherwise it ends with a retryable 503 once the owner
    # resumes, which used to be followed by a second, successful attempt; with
    # the abort disabled only the per-attempt settlement check prevents that.
    if not abortable:
        monkeypatch.setattr("logfn.sinks._Batch.cancel", lambda self: None)
    release = threading.Event()
    calls: list[str] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        calls.append("call")
        try:
            while held or not release.is_set():
                await asyncio.sleep(0.005)
        except asyncio.CancelledError:
            calls.append("cancelled")
            raise
        return 503 if len(calls) == 1 else 204

    drops: list[tuple[int, str]] = []
    sink = SinkHttp(
        URL, transport=transport, timeout=0.05 if held else 30, retry_attempts=3, backoff_ms=0,
        on_drop=lambda n, r: drops.append((n, r)), on_error=lambda _: None,
    )
    sink._batch_budget = 0.3  # Keeps the test short; the budget itself is tested above.
    stopped = asyncio.new_event_loop()

    async def start_sending() -> None:
        sink([event("stranded")])
        await eventually(lambda: calls == ["call"])

    try:
        stopped.run_until_complete(start_sending())
        asyncio.run(sink.close())
        settled = sink.stats()
        assert drops == [(1, "closed")]
        assert settled == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 1, "failed_batches": 0}
        release.set()
        stopped.run_until_complete(asyncio.sleep(0.3))
        # One outcome per event: a held attempt is aborted, and none follows.
        assert calls.count("call") == 1
        if held:
            assert calls == ["call", "cancelled"]
        assert sink.stats() == settled and drops == [(1, "closed")]
    finally:
        for task in asyncio.all_tasks(stopped):
            task.cancel()
        stopped.run_until_complete(asyncio.sleep(0))
        stopped.close()


def _dripping_collector(closed: threading.Event) -> tuple[socket.socket, int]:
    # Sends a status line, then one header line every 50 ms for 10 s; records
    # when the client closes the connection.
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(4)

    def handle(conn: socket.socket) -> None:
        with conn:
            conn.settimeout(1)
            with contextlib.suppress(OSError):
                conn.recv(65536)
            try:
                conn.sendall(b"HTTP/1.1 204 No Content\r\n")
                end = time.monotonic() + 10
                while time.monotonic() < end:
                    conn.sendall(b"X-Drip: 1\r\n")
                    time.sleep(0.05)
            except OSError:
                closed.set()

    def serve() -> None:
        with contextlib.suppress(OSError):
            while True:
                conn, _ = server.accept()
                _in_thread(lambda conn=conn: handle(conn))

    _in_thread(serve)
    return server, server.getsockname()[1]


def test_default_transport_releases_the_connection_when_an_attempt_times_out() -> None:
    closed = threading.Event()
    server, port = _dripping_collector(closed)
    drops: list[tuple[int, str]] = []
    try:
        sink = SinkHttp(f"http://127.0.0.1:{port}/ingest", timeout=0.3, retry_attempts=1, on_error=lambda e: None, on_drop=lambda n, r: drops.append((n, r)))
        logger = create_logger("drip", sinks=[sink])
        started = time.monotonic()

        async def main() -> None:
            logger.info("hello")
            await logger.flush()

        # asyncio.run also waits for executor threads; nothing may outlive the attempt.
        asyncio.run(main())
        assert time.monotonic() - started < 2
        assert drops == [(1, "delivery_failed")]
        assert closed.wait(3), "the collector still holds the connection"
    finally:
        server.close()


@pytest.fixture
def blackhole() -> Iterator[tuple[str, int]]:
    """An address whose TCP connect neither completes nor fails: a listener
    with a full accept queue (Linux drops further SYNs) or an unrouted
    TEST-NET-1 address. Skips where neither behaves that way."""
    kept: list[socket.socket] = []

    def hangs(address: tuple[str, int]) -> bool:
        probe = socket.socket()
        probe.settimeout(0.3)
        try:
            probe.connect(address)
        except TimeoutError:
            return True
        except OSError:
            return False
        finally:
            probe.close()
        return False

    try:
        listener = socket.socket()
        kept.append(listener)
        listener.bind(("127.0.0.1", 0))
        listener.listen(0)
        address = listener.getsockname()
        for _ in range(4):
            filler = socket.socket()
            kept.append(filler)
            filler.setblocking(False)
            with contextlib.suppress(OSError):
                filler.connect(address)
        time.sleep(0.05)
        if hangs(address):
            yield address
        elif hangs(("192.0.2.1", 9)):
            yield ("192.0.2.1", 9)
        else:
            pytest.skip("no blackholed address on this host")
    finally:
        for sock in kept:
            sock.close()


def _multi_address(monkeypatch: pytest.MonkeyPatch, address: tuple[str, int]) -> list[tuple[float, socket.socket]]:
    """Resolves multi.test to three copies of ``address`` and records every connect."""
    real_getaddrinfo = socket.getaddrinfo

    def getaddrinfo(host: Any, port: Any, *args: Any, **kwargs: Any) -> Any:
        if host == "multi.test":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", address)] * 3
        return real_getaddrinfo(host, port, *args, **kwargs)

    connects: list[tuple[float, socket.socket]] = []
    real_connect = socket.socket.connect

    def connect(self: socket.socket, address: Any) -> None:
        connects.append((time.monotonic(), self))
        real_connect(self, address)

    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    monkeypatch.setattr(socket.socket, "connect", connect)
    return connects


@pytest.mark.parametrize("scheme", ["http", "https"])
def test_default_transport_stops_connecting_at_the_attempt_deadline(
    scheme: str, blackhole: tuple[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    # The name resolves to three blackholed addresses. Each attempt may try
    # only until its deadline; after close() returns no connect may start and
    # no socket may stay open.
    connects = _multi_address(monkeypatch, blackhole)
    sink = SinkHttp(f"{scheme}://multi.test:{blackhole[1]}/ingest", timeout=0.2, retry_attempts=2, backoff_ms=0, on_error=lambda e: None)
    sink([event("m")])
    asyncio.run(sink.close())
    closed_at = time.monotonic()
    time.sleep(0.6)  # Longer than the two remaining addresses would take.

    assert sink.stats()["dropped"] == 1
    assert [at for at, _ in connects if at > closed_at] == []
    assert len(connects) == 2  # One address per attempt.
    assert all(sock.fileno() == -1 for _, sock in connects)


def test_cancelling_the_default_transport_stops_a_connect_in_progress(
    blackhole: tuple[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    connects = _multi_address(monkeypatch, blackhole)

    async def main() -> float:
        task = asyncio.create_task(logfn.sinks.stdlib_transport(f"http://multi.test:{blackhole[1]}/", b"{}", {}, 5.0))
        await eventually(lambda: len(connects) == 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return time.monotonic()

    cancelled_at = asyncio.run(main())
    deadline = cancelled_at + 1
    while connects[0][1].fileno() != -1 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert connects[0][1].fileno() == -1, "the connecting socket outlived the cancellation"
    time.sleep(0.3)
    assert len(connects) == 1  # No further address after the abort.


@pytest.mark.parametrize(("reply", "outcome"), [(204, "sent"), (400, "delivery_failed")])
def test_a_drain_cancelled_after_its_delivery_finished_keeps_its_outcome(reply: int, outcome: str) -> None:
    # The drain is cancelled (asyncio.run teardown, a loop cancel) after its
    # delivery finished but before it resumed: the batch has its real outcome
    # and is not sent again.
    transport = Scripted(reply)
    errors: list[BaseException] = []

    def named(suffix: str) -> asyncio.Task[Any]:
        return next(t for t in asyncio.all_tasks() if t.get_coro().__qualname__.endswith(suffix))  # type: ignore[union-attr]

    async def cancelling(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        drain = named("._drain")
        named("._deliver").add_done_callback(lambda _delivery: drain.cancel())
        return await transport(url, body, headers, timeout)

    sink = SinkHttp(URL, transport=cancelling, batch_size=1, on_error=errors.append)

    async def main() -> None:
        sink([event("once")])
        await eventually(lambda: sink.stats()["in_flight"] == 0)

    asyncio.run(main())
    asyncio.run(sink.close())
    assert transport.batches == [["once"]]
    stats = sink.stats()
    if outcome == "sent":
        assert stats == {"queued": 0, "in_flight": 0, "sent": 1, "dropped": 0, "failed_batches": 0}
        assert errors == []
    else:
        assert stats == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 1, "failed_batches": 1}
        assert [type(error) for error in errors] == [logfn.sinks.DeliveryError]


def test_an_abort_during_a_connect_that_completes_at_once_sends_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    # A non-blocking connect may complete synchronously; an abort that landed
    # meanwhile must still stop the request.
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    server.settimeout(2)

    def connect_at_once(self: Any, sock: socket.socket, sockaddr: Any, limit: float) -> None:
        self.abort()  # From another thread in reality.
        sock.setblocking(True)
        sock.connect(sockaddr)

    monkeypatch.setattr(logfn.sinks._Attempt, "_connect", connect_at_once)
    attempt = logfn.sinks._Attempt(2.0, "127.0.0.1")
    try:
        with pytest.raises(ConnectionAbortedError):
            logfn.sinks._post(f"http://127.0.0.1:{server.getsockname()[1]}/", b"{}", {}, 2.0, attempt)
        connection, _ = server.accept()
        with connection:
            connection.settimeout(2)
            assert connection.recv(1024) == b""  # Closed without a request.
    finally:
        server.close()


def test_the_default_transport_releases_its_attempt_when_its_thread_cannot_start(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts: list[Any] = []
    real = logfn.sinks._Attempt

    def recording(timeout: float, host: str) -> Any:
        attempts.append(real(timeout, host))
        return attempts[-1]

    def refuse(self: threading.Thread) -> None:
        raise RuntimeError("can't start new thread")

    slots = logfn.sinks._ResolverSlots(1, 1)
    monkeypatch.setattr(logfn.sinks, "_resolver_slots", slots)
    monkeypatch.setattr(logfn.sinks, "_Attempt", recording)
    monkeypatch.setattr(logfn.sinks.threading.Thread, "start", refuse)
    with pytest.raises(RuntimeError):
        asyncio.run(logfn.sinks.stdlib_transport("http://localhost:9/", b"{}", {}, 1.0))
    assert attempts[0]._wake_reader is None and attempts[0]._sock is None
    assert slots._held == {}, "the resolver slot was not released"


def _open_fds() -> int:
    for directory in ("/proc/self/fd", "/dev/fd"):
        if os.path.isdir(directory):
            return len(os.listdir(directory))
    pytest.skip("cannot count open file descriptors on this platform")


def _http_threads() -> list[threading.Thread]:
    return [thread for thread in threading.enumerate() if thread.name == "logfn-http"]


def test_a_stalled_resolver_holds_no_sockets_and_a_bounded_number_of_threads(
    monkeypatch: pytest.MonkeyPatch, collector: tuple[str, list[dict[str, Any]], list[str]]
) -> None:
    # Name resolution cannot be interrupted. While it hangs, abandoned
    # attempts must not pile up threads or descriptors: at most the cap is
    # outstanding, further attempts fail at once without a thread, and
    # delivery works again once the resolver answers.
    url, received, _auth = collector
    gate = threading.Event()
    real_getaddrinfo = socket.getaddrinfo

    def held(host: Any, *args: Any, **kwargs: Any) -> Any:
        if host == "stalled.test":
            # Released lookups fail without asking the real resolver, so
            # teardown does not depend on live DNS.
            gate.wait(10)
            raise socket.gaierror(socket.EAI_NONAME, "stalled.test")
        return real_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", held)
    monkeypatch.setattr(logfn.sinks, "_resolver_slots", logfn.sinks._ResolverSlots(3, 64))
    assert _http_threads() == []
    errors: list[BaseException] = []
    try:
        base_fds = _open_fds()
        sink = SinkHttp(
            "http://stalled.test/ingest", batch_size=1, timeout=0.02, retry_attempts=3, backoff_ms=0, on_error=errors.append
        )

        async def main() -> float:
            for i in range(20):
                sink([event(f"m{i}")])
                await sink.flush()
                assert len(_http_threads()) <= 3
            started = time.monotonic()
            await sink.close()
            return time.monotonic() - started

        close_took = asyncio.run(main())
        assert close_took < 0.5
        assert len(_http_threads()) == 3
        assert _open_fds() <= base_fds  # The stalled attempts hold no descriptors.
        assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 20, "failed_batches": 20}
        assert any(isinstance(error, logfn.sinks.ResolverBusyError) for error in errors)
    finally:
        gate.set()
    deadline = time.monotonic() + 5
    while _http_threads() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert _http_threads() == []

    healthy = SinkHttp(url, batch_size=1)
    healthy([event("after")])
    asyncio.run(healthy.close())
    assert [e["msg"] for e in received] == ["after"]
    assert healthy.stats()["sent"] == 1


def test_a_host_whose_lookups_stall_does_not_hold_up_sinks_for_other_hosts(
    monkeypatch: pytest.MonkeyPatch, collector: tuple[str, list[dict[str, Any]], list[str]]
) -> None:
    # The resolver cap bounds one host's stalled lookups; a sink posting to an
    # IP literal or to another hostname keeps delivering meanwhile.
    url, received, _auth = collector
    port = url.split(":")[2].split("/")[0]
    gate = threading.Event()
    real_getaddrinfo = socket.getaddrinfo

    def held(host: Any, *args: Any, **kwargs: Any) -> Any:
        if host == "stalled.test":
            # Released lookups fail without asking the real resolver, so
            # teardown does not depend on live DNS.
            gate.wait(10)
            raise socket.gaierror(socket.EAI_NONAME, "stalled.test")
        return real_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", held)
    assert _http_threads() == []
    errors: list[BaseException] = []
    try:
        stalled = SinkHttp("http://stalled.test/ingest", batch_size=1, timeout=0.02, retry_attempts=1, backoff_ms=0)
        literal = SinkHttp(url, batch_size=1, retry_attempts=1, on_error=errors.append)
        named = SinkHttp(f"http://localhost:{port}/ingest", batch_size=1, retry_attempts=1, on_error=errors.append)

        async def main() -> None:
            base_fds = _open_fds()
            for i in range(10):
                stalled([event(f"s{i}")])
                await stalled.flush()
            assert len(_http_threads()) <= 4  # The per-host cap.
            assert _open_fds() <= base_fds  # The stalled lookups hold none.
            for i in range(3):
                literal([event(f"ip{i}")])
                await literal.flush()
                named([event(f"name{i}")])
                await named.flush()

        asyncio.run(main())
        assert errors == []
        assert literal.stats()["sent"] == 3 and named.stats()["sent"] == 3
        assert sorted(e["msg"] for e in received) == ["ip0", "ip1", "ip2", "name0", "name1", "name2"]
        assert stalled.stats()["dropped"] == 10
        assert len(_http_threads()) <= 4
    finally:
        gate.set()
    deadline = time.monotonic() + 5
    while _http_threads() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert _http_threads() == []


async def _cancelled_request(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
    future: asyncio.Future[int] = asyncio.get_running_loop().create_future()
    future.cancel()
    return await future  # The transport's own request was cancelled.


def _cancelled_at_once(url: str, body: bytes, headers: dict[str, str], timeout: float) -> Any:
    raise asyncio.CancelledError


@pytest.mark.parametrize("raises", [_cancelled_request, _cancelled_at_once])
def test_a_cancelled_error_from_the_transport_is_a_failed_attempt(raises: Any) -> None:
    # Not a cancellation of the delivery: it must not put the batch back with
    # a fresh budget (an endless retry loop), but use up the retry budget.
    calls = 0

    def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> Any:
        nonlocal calls
        calls += 1
        return raises(url, body, headers, timeout)

    errors: list[BaseException] = []
    sink = SinkHttp(URL, transport=transport, batch_size=1, retry_attempts=2, timeout=0.001, backoff_ms=0, on_error=errors.append)

    async def main() -> float:
        sink([event("m")])
        started = time.monotonic()
        await asyncio.wait_for(sink.flush(), 3)
        return time.monotonic() - started

    assert asyncio.run(main()) < sink._batch_budget
    assert calls == 2
    assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 1, "failed_batches": 1}
    assert [type(error) for error in errors] == [ConnectionAbortedError]


@pytest.mark.parametrize("reason", ["closed", "queue_full"])
def test_on_drop_is_not_reentered_by_a_drop_it_causes(reason: str) -> None:
    # An on_drop that logs to its own sink drops again (closed, or full with
    # max_queue 1); that drop is counted but must not call on_drop
    # recursively until the stack overflows.
    drops: list[tuple[int, str]] = []
    sink = SinkHttp(URL, transport=Scripted(), batch_size=100, max_queue=1, on_drop=lambda n, r: on_drop(n, r))

    def on_drop(count: int, why: str) -> None:
        drops.append((count, why))
        sink([event("diagnostic")])

    if reason == "closed":
        asyncio.run(sink.close())
        sink([event("late")])
    else:
        sink([event("first")])
        sink([event("second")])
    assert drops == [(1, reason)]
    assert sink.stats()["dropped"] == 2  # Every event that was dropped, once.


def test_on_drop_still_reports_drops_from_other_threads_while_it_runs() -> None:
    # The guard is per thread: another thread's drop is not its own nesting.
    drops: list[str] = []
    entered, release = threading.Event(), threading.Event()
    sink = SinkHttp(URL, transport=Scripted(), on_drop=lambda n, r: on_drop(n, r))

    def on_drop(count: int, reason: str) -> None:
        drops.append(threading.current_thread().name)
        if len(drops) == 1:
            entered.set()
            release.wait(5)

    asyncio.run(sink.close())
    first = threading.Thread(target=sink, args=([event("a")],), name="first")
    first.start()
    assert entered.wait(5)
    second = threading.Thread(target=sink, args=([event("b")],), name="second")
    second.start()
    second.join(5)
    release.set()
    first.join(5)
    assert drops == ["first", "second"]


@pytest.mark.parametrize("status", [400, 500])
@pytest.mark.parametrize("path", ["direct", "logger"])
@pytest.mark.parametrize("callback", ["on_error", "on_drop"])
def test_a_callback_is_not_called_back_for_its_own_diagnostic(
    callback: str, path: str, status: int, capsys: pytest.CaptureFixture[str]
) -> None:
    # A callback that logs a diagnostic through its own sink must not be
    # called for that diagnostic's failure or drop: with a collector that
    # fails at once, each report would log another event without end.
    transport = Scripted(status)
    errors: list[BaseException] = []
    callback_calls = 0

    def diagnose(*_: Any) -> None:
        nonlocal callback_calls
        callback_calls += 1
        if callback_calls > 10:
            return  # Keeps a regression finite.
        if path == "direct":
            sink([event("diagnostic")])
        else:
            logger.warn("diagnostic")

    sink = SinkHttp(
        URL,
        transport=transport,
        batch_size=1,
        retry_attempts=1,
        backoff_ms=0,
        on_error=diagnose if callback == "on_error" else errors.append,
        on_drop=diagnose if callback == "on_drop" else None,
    )
    logger = create_logger("svc", sinks=[sink])

    def log(msg: str) -> None:
        if path == "direct":
            sink([event(msg)])
        else:
            logger.info(msg)

    async def main() -> None:
        log("one")
        await sink.flush()
        await asyncio.sleep(0.2)
        assert len(transport.calls) == 2
        assert callback_calls == 1
        assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 2, "failed_batches": 2}
        # The diagnostic's own failure goes to stderr once.
        assert capsys.readouterr().err.count("[logfn http-sink error]") == 1

        # A later independent event's failure is reported again.
        log("two")
        await sink.flush()
        await asyncio.sleep(0.2)
        assert len(transport.calls) == 4
        assert callback_calls == 2
        assert capsys.readouterr().err.count("[logfn http-sink error]") == 1

    asyncio.run(main())
    if callback == "on_drop":
        assert len(errors) == 2


def test_a_batch_mixing_a_diagnostic_with_an_independent_event_is_reported() -> None:
    transport = Scripted(400)
    calls = 0

    def on_error(error: BaseException) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            sink([event("diagnostic")])

    sink = SinkHttp(URL, transport=transport, batch_size=2, flush_interval_ms=60_000, retry_attempts=1, on_error=on_error)

    async def main() -> None:
        sink([event("one")])
        await sink.flush()
        assert calls == 1
        sink([event("two")])  # Joins the queued diagnostic in one batch.
        await sink.flush()

    asyncio.run(main())
    assert transport.batches == [["one"], ["diagnostic", "two"]]
    assert calls == 2


@pytest.mark.parametrize("op", ["flush", "close"])
def test_a_transport_that_ignores_cancellation_is_abandoned_within_the_budget(op: str) -> None:
    # A timed-out call is cancelled; one whose cleanup never finishes must
    # not hold the batch, flush() or close() past the batch's budget, and its
    # late result must not change the outcome.
    gate = threading.Event()
    calls = 0

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        nonlocal calls
        calls += 1
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            # Cleanup that ignores the cancellation (for at most 2s, so a
            # regression fails instead of hanging the test run).
            stop = time.monotonic() + 2
            while not gate.is_set() and time.monotonic() < stop:
                with contextlib.suppress(asyncio.CancelledError):
                    await asyncio.sleep(0.01)
        return 204

    errors: list[BaseException] = []
    sink = SinkHttp(URL, transport=transport, timeout=0.01, retry_attempts=1, backoff_ms=0, on_error=errors.append)

    async def main() -> float:
        sink([event("m")])
        started = time.monotonic()
        await asyncio.wait_for(getattr(sink, op)(), 3)
        elapsed = time.monotonic() - started
        assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 1, "failed_batches": 1}
        gate.set()
        await asyncio.sleep(0.05)  # The abandoned call now returns 204.
        return elapsed

    assert asyncio.run(main()) < sink._batch_budget + 0.2
    assert calls == 1
    assert sink.stats()["sent"] == 0
    assert [type(error) for error in errors] == [TimeoutError]


@pytest.mark.parametrize("op", ["flush", "close"])
def test_flush_waits_for_a_drain_it_started_no_longer_than_the_batch_deadline(op: str) -> None:
    # The drain flush() starts is bounded by the deadline of the batch it
    # sends, like a batch another loop is sending.
    errors: list[BaseException] = []
    sink = SinkHttp(URL, transport=Scripted("hang"), timeout=5, retry_attempts=1, on_error=errors.append)
    sink._batch_budget = 0.2  # Shorter than one attempt: only the deadline can end the wait.

    async def main() -> float:
        sink([event("m")])
        started = time.monotonic()
        await asyncio.wait_for(getattr(sink, op)(), 3)
        return time.monotonic() - started

    assert asyncio.run(main()) < 1
    reason = "closed" if op == "close" else "delivery_failed"
    assert sink.stats() == {
        "queued": 0,
        "in_flight": 0,
        "sent": 0,
        "dropped": 1,
        "failed_batches": 1 if reason == "delivery_failed" else 0,
    }
    assert [type(error) for error in errors] == [TimeoutError]


def test_header_names_are_case_insensitive_and_later_sources_win() -> None:
    transport = Scripted()
    headers = {"content-type": "application/x-ndjson", "AUTHORIZATION": "Basic old", "X-Custom": "v"}
    sink = SinkHttp(URL, auth_token="tok", headers=headers, transport=transport)
    sink([event("m")])
    asyncio.run(sink.flush())
    assert transport.calls[0][1] == {"content-type": "application/x-ndjson", "X-Custom": "v", "Authorization": "Bearer tok"}


def test_events_the_transport_logs_wait_for_the_interval() -> None:
    # Sending what the transport logged makes it log again: without the wait
    # each batch would start the next at once, without end.
    calls: list[float] = []

    async def scenario() -> None:
        async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
            calls.append(time.monotonic())
            logger.info("transport diagnostic")
            return 200

        sink = SinkHttp(URL, transport=transport, batch_size=1, flush_interval_ms=200)
        logger = create_logger("svc", sinks=[sink])
        logger.info("event")
        await asyncio.sleep(0.1)
        assert len(calls) == 1
        await eventually(lambda: len(calls) == 2)
        assert calls[1] - calls[0] >= 0.15
        await sink.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("owner", ["own loop", "stopped loop"])
def test_a_cancelled_close_drops_the_batches_in_flight_once(owner: str) -> None:
    drops: list[tuple[int, str]] = []
    sink = SinkHttp(URL, transport=Scripted("hang"), batch_size=1, timeout=30, on_drop=lambda n, r: drops.append((n, r)))
    stopped = asyncio.new_event_loop()

    async def start_sending() -> None:
        sink([event("held")])
        await eventually(lambda: sink.stats()["in_flight"] == 1)

    async def cancel_close() -> None:
        if owner == "own loop":
            await start_sending()
        closing = asyncio.ensure_future(sink.close())
        await asyncio.sleep(0.2)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        # Settled by close() itself, not by asyncio.run() cancelling the drain.
        assert drops == [(1, "closed")]
        assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 1, "failed_batches": 0}
        await asyncio.sleep(0.05)  # The owner's delivery is cancelled, not settled again.
        assert drops == [(1, "closed")] and sink.stats()["dropped"] == 1

    try:
        if owner == "stopped loop":
            stopped.run_until_complete(start_sending())
        asyncio.run(cancel_close())
        stopped.run_until_complete(asyncio.sleep(0.05))  # A late resume changes nothing.
        assert drops == [(1, "closed")] and sink.stats()["dropped"] == 1
        assert not asyncio.all_tasks(stopped)
    finally:
        for task in asyncio.all_tasks(stopped):
            task.cancel()
        stopped.run_until_complete(asyncio.sleep(0))
        stopped.close()


@pytest.mark.parametrize(
    ("where", "redact_error", "reported"),
    [
        ("on_error", RuntimeError, ["on_error"]),
        ("on_drop", None, ["on_drop"]),
        ("redaction", asyncio.CancelledError, ["CancelledError"]),
    ],
)
def test_a_cancelled_error_raised_by_sink_caller_code_is_contained(
    where: str, redact_error: Any, reported: list[str]
) -> None:
    # Synchronous caller code raising CancelledError is that code's failure:
    # calling the sink never raises, "a" is dropped and "b" is still queued.
    calls: list[str] = []

    def cancelling(*args: Any) -> None:
        calls.append(where)
        raise asyncio.CancelledError

    sink = SinkHttp(
        URL,
        transport=Scripted(),
        max_queue=1,
        on_error=cancelling if where == "on_error" else lambda error: calls.append(type(error).__name__),
        on_drop=cancelling if where == "on_drop" else None,
    )
    redact = sink._redact

    def failing_redact(event: LogEvent) -> LogEvent:
        if event["msg"] == "a" and redact_error is not None:
            raise redact_error
        return redact(event)

    sink._redact = failing_redact  # type: ignore[method-assign]
    if where == "on_drop":
        sink([event("a"), event("b")])  # The older event exceeds max_queue.
    else:
        sink([event("a")])
        sink([event("b")])
    assert calls == reported
    assert sink.stats() == {"queued": 1, "in_flight": 0, "sent": 0, "dropped": 1, "failed_batches": 0}
    asyncio.run(sink.flush())
    assert sink.stats()["sent"] == 1


class _AcquireGate:
    """A lock that holds one thread before it takes the lock, until resumed."""

    def __init__(self, lock: Any, thread: int) -> None:
        self._lock, self._thread = lock, thread
        self.arrived, self.resume, self.done = threading.Event(), threading.Event(), threading.Event()

    def __enter__(self) -> None:
        if threading.get_ident() == self._thread and not self.done.is_set():
            self.arrived.set()
            assert self.resume.wait(5), "not resumed"
        self._lock.acquire()

    def __exit__(self, *_exc: object) -> None:
        self._lock.release()
        if threading.get_ident() == self._thread and self.resume.is_set():
            self.done.set()


def test_a_batch_put_back_by_another_loop_after_close_started_is_dropped_once() -> None:
    # Another loop's drain is cancelled before close() starts and is about to
    # put its batch back; it takes the lock only once a cancelled close() has
    # emptied the queue and listed the batches in flight. That batch must be
    # dropped as "closed", never queued again on the closed sink.
    drops: list[tuple[int, str]] = []
    main = threading.get_ident()
    sink = SinkHttp(URL, transport=Scripted("hang"), batch_size=1, timeout=30, on_drop=lambda n, r: on_drop(n, r))
    other_loop = asyncio.new_event_loop()
    other = threading.Thread(target=other_loop.run_forever, daemon=True)
    other.start()
    gate = _AcquireGate(sink._lock, other.ident or 0)

    def on_drop(count: int, reason: str) -> None:
        drops.append((count, reason))
        if threading.get_ident() == main and not gate.resume.is_set():
            gate.resume.set()  # The foreign put-back runs now, between close()'s snapshot and settlement.
            assert gate.done.wait(5), "put-back not finished"

    async def scenario() -> None:
        sink([event("a"), event("b")])  # One in flight here, one queued behind it.
        await eventually(lambda: (stats := sink.stats())["queued"] == 1 and stats["in_flight"] == 2)
        sink._lock = gate  # type: ignore[assignment]
        other_loop.call_soon_threadsafe(sink._drains[other_loop].cancel)
        assert gate.arrived.wait(5)
        closing = asyncio.ensure_future(sink.close())
        await asyncio.sleep(0.05)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        assert sink.stats() == {"queued": 0, "in_flight": 0, "sent": 0, "dropped": 3, "failed_batches": 0}
        assert sorted(drops) == [(1, "closed")] * 3

    try:
        other_loop.call_soon_threadsafe(sink, [event("foreign")])
        deadline = time.monotonic() + 5
        while sink.stats()["in_flight"] != 1:
            assert time.monotonic() < deadline
            time.sleep(0.005)
        asyncio.run(scenario())
    finally:
        other_loop.call_soon_threadsafe(other_loop.stop)
        other.join(5)
        other_loop.close()
