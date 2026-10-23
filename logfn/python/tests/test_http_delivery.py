import asyncio
import json

import httpx
import pytest

from logfn.sinks import SinkHttp
from logfn.types import LogEvent


def event(msg: str = "test") -> LogEvent:
    return {"ts": "2026-01-14T12:00:00.000Z", "level": "info", "msg": msg, "name": "test", "version": "0"}


async def test_envelope_batch_bounds_and_borrowed_client() -> None:
    requests = []
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", auth_token="secret", batch_size=2, client=client)
        sink([event(str(i)) for i in range(5)])
        await sink.flush()
        assert [len(json.loads(r.content)["events"]) for r in requests] == [2, 2, 1]
        assert all(r.headers["authorization"] == "Bearer secret" for r in requests)
        await sink.close()
        assert not client.is_closed
        with pytest.raises(RuntimeError):
            sink([event()])


@pytest.mark.parametrize("status", [408, 429, 503])
async def test_retryable_statuses(status: int) -> None:
    calls = []
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(status if len(calls) == 1 else 202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", attempts=2, backoff_ms=0, client=client)
        sink([event()])
        await sink.flush()
        assert len(calls) == 2
        assert not sink.buffer
        await sink.close()


async def test_permanent_failure_retained_and_close_retry() -> None:
    calls = []
    status = 401
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(status)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", attempts=5, client=client)
        sink([event()])
        with pytest.raises(httpx.HTTPStatusError):
            await sink.close()
        assert len(calls) == 1 and len(sink.buffer) == 1
        status = 202
        await sink.close()
        assert len(calls) == 2


async def test_flush_waits_for_active_delivery_and_new_arrivals() -> None:
    started, finish = asyncio.Event(), asyncio.Event()
    received = []
    async def handler(request: httpx.Request) -> httpx.Response:
        received.extend(json.loads(request.content)["events"])
        started.set()
        await finish.wait()
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", batch_size=1, client=client)
        sink([event("first")])
        await started.wait()
        sink([event("second")])
        flush = asyncio.create_task(sink.flush())
        await asyncio.sleep(0)
        assert not flush.done()
        finish.set()
        await flush
        assert [e["msg"] for e in received] == ["first", "second"]
        await sink.close()


async def test_interval_delivers_small_batch() -> None:
    delivered = asyncio.Event()
    async def handler(request: httpx.Request) -> httpx.Response:
        delivered.set()
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", flush_interval_ms=5, client=client)
        sink([event()])
        await asyncio.wait_for(delivered.wait(), 1)
        await sink.close()


async def test_timeout_retries_with_fresh_request() -> None:
    calls = 0
    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            await asyncio.sleep(10)
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", timeout=.01, attempts=2, backoff_ms=0, client=client)
        sink([event()])
        await sink.flush()
        assert calls == 2
        await sink.close()


async def test_cancelled_flush_retains_events() -> None:
    started = asyncio.Event()
    async def handler(request: httpx.Request) -> httpx.Response:
        started.set()
        await asyncio.sleep(10)
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", client=client)
        sink([event()])
        task = asyncio.create_task(sink.flush())
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert len(sink.buffer) == 1


async def test_overflow_retains_newest_events() -> None:
    received = []
    def handler(request: httpx.Request) -> httpx.Response:
        received.extend(json.loads(request.content)["events"])
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", max_queue=2, client=client)
        sink([event("old"), event("middle"), event("new")])
        assert sink.overflow_evictions == 1
        await sink.flush()
        assert [e["msg"] for e in received] == ["middle", "new"]
        await sink.close()
        assert sink.overflow_evictions == 1


async def test_failed_send_requeue_counts_evictions() -> None:
    started, finish = asyncio.Event(), asyncio.Event()
    calls = []
    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content)["events"])
        if len(calls) == 1:
            started.set()
            await finish.wait()
            return httpx.Response(503)
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", max_queue=2, batch_size=10, attempts=1, client=client)
        sink([event("first"), event("second")])
        delivery = asyncio.create_task(sink.flush())
        await started.wait()
        sink([event("third"), event("fourth")])
        assert sink.overflow_evictions == 0
        finish.set()
        with pytest.raises(httpx.HTTPStatusError):
            await delivery
        assert sink.overflow_evictions == 2
        await sink.close()
        assert [item["msg"] for item in calls[1]] == ["third", "fourth"]
        assert sink.overflow_evictions == 2


async def test_logger_flush_reports_delivery_failure() -> None:
    from logfn.core import Logger
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", attempts=1, client=client)
        logger = Logger("test", [sink])
        logger.info("retained")
        with pytest.raises(httpx.HTTPStatusError):
            await logger.flush()
        assert len(sink.buffer) == 1


async def test_real_http_delivery_retries_and_preserves_envelope() -> None:
    received = []
    handlers = set()
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        handlers.add(task)
        try:
            head = await reader.readuntil(b'\r\n\r\n')
            lines = head.decode('ascii').split('\r\n')
            headers = dict(line.split(': ', 1) for line in lines[1:] if ': ' in line)
            body = await reader.readexactly(int(headers['Content-Length']))
            received.append((headers, json.loads(body)))
            status = b'503 Service Unavailable' if len(received) == 1 else b'202 Accepted'
            writer.write(b'HTTP/1.1 ' + status + b'\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            handlers.discard(task)
    server = await asyncio.start_server(handle, '127.0.0.1', 0)
    port = server.sockets[0].getsockname()[1]
    sink = SinkHttp(f'http://127.0.0.1:{port}/logs', auth_token='test-token', attempts=2, backoff_ms=0)
    try:
        sink([event('real request')])
        await sink.close()
        assert len(received) == 2
        assert all(body == {'events': [event('real request')]} for _, body in received)
        assert all(headers['Authorization'] == 'Bearer test-token' for headers, _ in received)
        assert not sink.buffer
        assert sink._client.is_closed
    finally:
        await sink._client.aclose()
        server.close()
        await server.wait_closed()
        if handlers:
            await asyncio.gather(*handlers)


@pytest.mark.parametrize("operation", ["flush", "close"])
async def test_explicit_drain_joins_interval_request_without_cancelling(operation: str) -> None:
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0
    cancelled = False
    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls, cancelled
        calls += 1
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled = True
            raise
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", client=client, batch_size=10, flush_interval_ms=1)
        sink([event("accepted")])
        await asyncio.wait_for(entered.wait(), 1)
        drain = asyncio.create_task(getattr(sink, operation)())
        try:
            for _ in range(10):
                await asyncio.sleep(0)
            assert not drain.done()
            assert not cancelled
            assert calls == 1
        finally:
            release.set()
            await drain
            await sink.close()
        assert calls == 1
        assert not sink.buffer
