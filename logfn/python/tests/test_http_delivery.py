import asyncio
import json
import httpx
import pytest
from logfn.sinks import SinkHttp


def event(msg="test"):
    return {"ts": "2026-01-14T12:00:00.000Z", "level": "info", "msg": msg, "name": "test", "version": "0"}


async def test_envelope_batch_bounds_and_borrowed_client():
    requests = []
    def handler(request):
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
async def test_retryable_statuses(status):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status if len(calls) == 1 else 202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", attempts=2, backoff_ms=0, client=client)
        sink([event()])
        await sink.flush()
        assert len(calls) == 2
        assert not sink.buffer
        await sink.close()


async def test_permanent_failure_retained_and_close_retry():
    calls = []
    status = 401
    def handler(request):
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


async def test_flush_waits_for_active_delivery_and_new_arrivals():
    started, finish = asyncio.Event(), asyncio.Event()
    received = []
    async def handler(request):
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


async def test_interval_delivers_small_batch():
    delivered = asyncio.Event()
    async def handler(request):
        delivered.set()
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", flush_interval_ms=5, client=client)
        sink([event()])
        await asyncio.wait_for(delivered.wait(), 1)
        await sink.close()


async def test_timeout_retries_with_fresh_request():
    calls = 0
    async def handler(request):
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


async def test_cancelled_flush_retains_events():
    started = asyncio.Event()
    async def handler(request):
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


async def test_overflow_retains_newest_events():
    received = []
    def handler(request):
        received.extend(json.loads(request.content)["events"])
        return httpx.Response(202)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", max_queue=2, client=client)
        sink([event("old"), event("middle"), event("new")])
        await sink.flush()
        assert [e["msg"] for e in received] == ["middle", "new"]
        await sink.close()


async def test_logger_flush_reports_delivery_failure():
    from logfn.core import Logger
    def handler(request):
        return httpx.Response(503)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        sink = SinkHttp("https://example.test", attempts=1, client=client)
        logger = Logger("test", [sink])
        logger.info("retained")
        with pytest.raises(httpx.HTTPStatusError):
            await logger.flush()
        assert len(sink.buffer) == 1
