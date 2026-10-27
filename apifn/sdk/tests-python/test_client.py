"""The generated Python client, installed from its wheel, against a local fixture server: the shared vectors,
timeouts, cancellation, bounded retries, transports and failure observation."""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import sys
import time
import warnings
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fixture_server import FixtureServer, scripted
from harness import MODULE, client_module, kwargs_for, operation_name, outcome_of, read_json, run_case, sdk

CATALOG = read_json("catalog/catalog.json")
SERIALIZATION = read_json("vectors/serialization.json")
AUTH = read_json("vectors/auth.json")
ERRORS = read_json("vectors/errors.json")
RETRY = read_json("vectors/retry.json")
pkg = sdk()
runtime = __import__(f"{MODULE}._runtime", fromlist=["_runtime"])


@pytest.fixture(scope="module")
def server() -> Iterator[FixtureServer]:
    instance = FixtureServer()
    instance.start()
    yield instance
    instance.stop()


@pytest.fixture(autouse=True)
def fresh(server: FixtureServer) -> None:
    server.reset()


def ok_response(operation_id: str) -> Any:
    """A success in the operation's first documented media type, so request vectors can ignore the response."""
    operation = next(candidate for candidate in CATALOG["operations"] if candidate["id"] == operation_id)
    success = next((response for response in operation["responses"] if response["kind"] == "success"), None)
    contents = success["contents"] if success else []
    if not contents:
        return scripted({"status": int(success["status"]) if success else 204})
    media = contents[0]["mediaType"]
    return scripted({"status": int(success["status"]), "headers": {"content-type": media}, "body": "{}" if media.endswith("json") else "ok"})


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def settled_requests(server: FixtureServer, seconds: float = 0.3) -> int:
    """The requests the server has received once a client that gave up early has had time to reach it."""
    time.sleep(seconds)
    return len(server.requests)


def client(server: FixtureServer, **options: Any) -> Any:
    return pkg.TasksClient(base_url=server.base_url, **options)


def expect_request(server: FixtureServer, name: str, expected: dict[str, Any]) -> None:
    assert len(server.requests) == 1, name
    request = server.requests[0]
    if "method" in expected:
        assert request.method == expected["method"], name
    if "path" in expected:
        assert request.path == expected["path"], name
    assert request.query == expected["query"], name
    for header, value in expected.get("headers", {}).items():
        assert request.headers.get(header) == value, f"{name}: {header}"
    for header in expected.get("absentHeaders", []):
        assert header not in request.headers, f"{name}: {header}"
    if "body" in expected:
        assert json.loads(request.body) == expected["body"], name
    if "bodyText" in expected:
        assert request.body.decode("utf-8") == expected["bodyText"], name
    if "bodyBytes" in expected:
        assert list(request.body) == expected["bodyBytes"], name


# Shared vectors.


@pytest.mark.parametrize("vector", SERIALIZATION["cases"], ids=lambda vector: vector["name"])
def test_serialization_vector(server: FixtureServer, vector: dict[str, Any]) -> None:
    server.reset([ok_response(vector["operation"])])
    outcome, _ = run(run_case(server.base_url, vector))
    assert outcome["ok"], outcome
    expect_request(server, vector["name"], vector["expect"])


@pytest.mark.parametrize("vector", SERIALIZATION["rejected"] + AUTH["rejected"], ids=lambda vector: vector["name"])
def test_rejected_vector_sends_nothing(server: FixtureServer, vector: dict[str, Any]) -> None:
    outcome, _ = run(run_case(server.base_url, vector, credentials=vector.get("credentials")))
    outcome.pop("rejectedAtCall", None)
    assert outcome == {"ok": False, "kind": vector["kind"], "attempts": 0}
    assert server.requests == []


@pytest.mark.parametrize("vector", AUTH["cases"], ids=lambda vector: vector["name"])
def test_auth_vector(server: FixtureServer, vector: dict[str, Any]) -> None:
    server.reset([ok_response(vector["operation"])])
    outcome, _ = run(run_case(server.base_url, vector, credentials=vector["credentials"]))
    assert outcome["ok"], outcome
    expect_request(server, vector["name"], vector["expect"])


@pytest.mark.parametrize("vector", ERRORS["cases"], ids=lambda vector: vector["name"])
def test_error_vector(server: FixtureServer, vector: dict[str, Any]) -> None:
    server.reset([scripted(vector["response"])])
    outcome, _ = run(run_case(server.base_url, vector, retry={"max_attempts": 1}))
    assert len(server.requests) == 1
    expected = vector["expect"]
    if "result" in expected:
        assert outcome == {"ok": True, "result": expected["result"]}
    elif "binaryResult" in expected:
        assert outcome == {"ok": True, "result": {"$bytes": expected["binaryResult"]}}
    else:
        error = expected["error"]
        assert outcome["kind"] == error["kind"]
        if error["kind"] == "http":
            assert (outcome["status"], outcome["declared"], outcome["body"]) == (error["status"], error["declared"], error["body"])


@pytest.mark.parametrize("vector", RETRY["cases"], ids=lambda vector: vector["name"])
def test_retry_vector(server: FixtureServer, vector: dict[str, Any]) -> None:
    server.reset([scripted({**response, "headers": {"content-type": "application/json", **response.get("headers", {})}, "body": "{}"}) for response in vector["responses"]])
    outcome, _ = run(run_case(server.base_url, vector, credentials={"bearerAuth": "t", "apiKeyQuery": "k"}))
    assert len(server.requests) == vector["expect"]["attempts"]
    if vector["expect"]["outcome"] == "success":
        assert outcome["ok"], outcome
    else:
        assert (outcome["kind"], outcome["status"], outcome["attempts"]) == ("http", vector["expect"]["status"], vector["expect"]["attempts"])


# Python argument binding and typed errors.


def test_missing_required_arguments_fail_at_the_call_and_none_fails_as_validation(server: FixtureServer) -> None:
    async def main() -> None:
        async with client(server) as tasks:
            with pytest.raises(TypeError):
                tasks.get_task(project_id="p")  # type: ignore[call-arg]
            with pytest.raises(pkg.ApiError) as caught:
                await tasks.get_task(project_id="p", task_id=None)
            assert (caught.value.kind, caught.value.attempts) == ("validation", 0)

    run(main())
    assert server.requests == []


def test_is_declared_error_narrows_documented_errors(server: FixtureServer) -> None:
    server.reset([scripted({"status": 404, "headers": {"content-type": "application/problem+json"}, "body": '{"title":"Not found","status":404}'}), scripted({"status": 418, "headers": {"content-type": "text/plain"}, "body": "teapot"})])

    async def main() -> None:
        async with client(server, credentials={"apiKeyQuery": "k", "bearerAuth": "t"}, retry={"max_attempts": 1}) as tasks:
            with pytest.raises(pkg.ApiHttpError) as declared:
                await tasks.get_task(project_id="p", task_id="t")
            assert pkg.is_operation_error(declared.value, "tasks.get") and pkg.is_declared_error(declared.value, "tasks.get")
            assert not pkg.is_operation_error(declared.value, "tasks.list")
            assert declared.value.body["title"] == "Not found"
            assert declared.value.headers["Content-Type"] == "application/problem+json"
            with pytest.raises(pkg.ApiHttpError) as undeclared:
                await tasks.create_task(project_id="p", body={"title": "x"})
            assert pkg.is_operation_error(undeclared.value, "tasks.create") and not pkg.is_declared_error(undeclared.value, "tasks.create")

    run(main())


def test_deprecated_operations_warn(server: FixtureServer) -> None:
    server.reset([scripted({"status": 204})])

    async def main() -> None:
        async with client(server, credentials={"bearerAuth": "t"}) as tasks:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                await tasks.delete_task(project_id="p", task_id="t")
            assert any(issubclass(warning.category, DeprecationWarning) and "replace_task" in str(warning.message) for warning in caught)

    run(main())


def test_json_bodies_that_cannot_be_serialized_are_validation_failures(server: FixtureServer) -> None:
    circular: dict[str, Any] = {"title": "t"}
    circular["self"] = circular
    events: list[Any] = []

    async def main() -> None:
        async with client(server, on_failure=events.append) as tasks:
            for body in ({"title": "t", "when": object()}, circular, {"title": "t", "estimate": float("nan")}):
                with pytest.raises(pkg.ApiError) as caught:
                    await tasks.create_task(project_id="p", body=body)
                assert (caught.value.kind, caught.value.attempts) == ("validation", 0)
                assert str(caught.value).startswith("Parameter body must be JSON-serializable: ")

    run(main())
    assert server.requests == []
    assert [(event["failure"]["kind"], event["failure"]["retryable"]) for event in events] == [("validation", False)] * 3


def test_retry_options_are_validated() -> None:
    for retry in ({"max_attempts": 0}, {"max_attempts": 11}, {"max_attempts": True}, {"base_delay": -1}, {"max_delay": float("inf")}, {"attempts": 2}):
        with pytest.raises(ValueError):
            pkg.TasksClient(retry=retry)
    for timeout in (0, -1, float("nan"), 10**400):
        with pytest.raises(ValueError):
            pkg.TasksClient(timeout=timeout)


# Retries.


def test_retries_a_read_after_a_dropped_connection(server: FixtureServer) -> None:
    server.reset([scripted({"destroy": True}), scripted({"status": 200, "headers": {"content-type": "application/json"}, "body": "{}"})])
    outcome, _ = run(run_case(server.base_url, {"operation": "tasks.get", "parameters": {"path": {"projectId": "p", "taskId": "t"}}}, credentials={"apiKeyQuery": "k"}))
    assert outcome["ok"]
    assert len(server.requests) == 2


def test_never_retries_a_write_under_catalog_v1(server: FixtureServer) -> None:
    server.reset([scripted({"status": 503}), scripted({"status": 200, "headers": {"content-type": "application/json"}, "body": '{"size":2}'})])
    outcome, _ = run(run_case(server.base_url, {"operation": "tasks.attachment.upload", "parameters": {"path": {"projectId": "p", "taskId": "t"}}, "bodyBytes": [1, 2]}, credentials={"bearerAuth": "t"}))
    assert (outcome["kind"], outcome["status"]) == ("http", 503)
    assert len(server.requests) == 1


def operation_spec(**overrides: Any) -> Any:
    """A runtime operation spec; retry="idempotent" stands for a write a future catalog declares idempotent."""
    fields: dict[str, Any] = {
        "id": "files.put",
        "name": "putFile",
        "method": "PUT",
        "path": "/files",
        "parameters": (),
        "body": runtime.BodySpec(media_type="application/octet-stream", kind="binary", required=True),
        "accept": ("application/json",),
        "success": ("json",),
        "errors": (),
        "security": (),
        "retry": "idempotent",
    }
    fields.update(overrides)
    return runtime.OperationSpec(**fields)


def direct_runtime(server: FixtureServer, **options: Any) -> Any:
    meta = runtime.SdkMetadata(
        api_id="example.tasks",
        api_version="2026-10-01",
        catalog_digest="sha256:" + "0" * 64,
        release_id="rel_test",
        target="python",
        package_name="example-tasks-sdk",
        package_version="1.0.0",
        default_base_url=None,
        default_timeout=2.0,
        default_retry=runtime.RetryPolicy(max_attempts=3, base_delay=0, max_delay=0),
    )
    settings: dict[str, Any] = {"base_url": server.base_url, "transport": None, "credentials": None, "timeout": None, "retry": None, "on_failure": None}
    settings.update(options)
    return runtime.ApiRuntime(meta, **settings)


def test_retries_a_declared_idempotent_write_replaying_its_bytes(server: FixtureServer) -> None:
    server.reset([scripted({"status": 503}), scripted({"status": 500}), scripted({"status": 503}), scripted({"status": 200})])

    async def main() -> None:
        target = direct_runtime(server)
        with pytest.raises(pkg.ApiHttpError) as caught:
            await target.request(operation_spec(), {"body": b"\x01\x02"})
        assert caught.value.attempts == 3
        assert [list(request.body) for request in server.requests] == [[1, 2]] * 3
        server.reset([scripted({"status": 504}), scripted({"status": 200, "headers": {"content-type": "application/json"}, "body": '{"size":2}'})])
        assert await target.request(operation_spec(), {"body": bytearray(b"\x01\x02")}) == {"size": 2}
        assert len(server.requests) == 2
        await target.aclose()

    run(main())


def test_never_retries_a_stream_body_even_when_declared_idempotent(server: FixtureServer) -> None:
    server.reset([scripted({"status": 503}), scripted({"status": 200, "headers": {"content-type": "application/json"}, "body": "{}"})])

    async def body() -> AsyncIterator[bytes]:
        yield b"\x01"
        yield b"\x02"

    async def main() -> None:
        target = direct_runtime(server)
        with pytest.raises(pkg.ApiHttpError):
            await target.request(operation_spec(), {"body": body()})
        await target.aclose()

    run(main())
    assert len(server.requests) == 1
    assert list(server.requests[0].body) == [1, 2]


def test_rejects_a_body_on_get_head_or_trace_without_sending(server: FixtureServer) -> None:
    calls: list[Any] = []

    async def transport(request: Any) -> Any:
        calls.append(request)
        return pkg.TransportResponse(status=200, headers=[], body=b"")

    async def main() -> None:
        for method in ("GET", "HEAD", "TRACE"):
            spec = operation_spec(method=method, body=runtime.BodySpec(media_type="application/json", kind="json", required=True), retry="read")
            with pytest.raises(pkg.ApiError) as caught:
                await direct_runtime(server, transport=transport).request(spec, {"body": {"a": 1}})
            assert (caught.value.kind, caught.value.attempts) == ("validation", 0)

    run(main())
    assert calls == []


# Timeouts, cancellation and concurrency.


def test_times_out_each_attempt_and_retries_a_read_within_the_budget(server: FixtureServer) -> None:
    server.reset([scripted({"delayMs": 500})] * 3)
    started = time.monotonic()
    outcome, events = run(run_case(server.base_url, {"operation": "tasks.get", "parameters": {"path": {"projectId": "p", "taskId": "t"}}}, credentials={"apiKeyQuery": "k"}, timeout=0.05))
    assert outcome == {"ok": False, "kind": "timeout", "attempts": 3}
    assert time.monotonic() - started < 1
    assert [event["failure"] for event in events] == [{"kind": "timeout", "retryable": True, "attempt": 3}]


def test_does_not_retry_a_timed_out_write(server: FixtureServer) -> None:
    server.reset([scripted({"delayMs": 1000})] * 2)

    async def main() -> None:
        async with client(server, credentials={"bearerAuth": "t"}) as tasks:
            with pytest.raises(pkg.ApiTimeoutError) as caught:
                await tasks.create_task(project_id="p", body={"title": "x"}, request_options={"timeout": 0.3})
            assert caught.value.attempts == 1

    run(main())
    assert settled_requests(server) == 1


def test_an_in_flight_call_does_not_block_a_concurrent_heartbeat(server: FixtureServer) -> None:
    server.reset([scripted({"status": 200, "headers": {"content-type": "application/json"}, "body": '{"id":"t","title":"x","status":"open"}', "delayMs": 300})])
    beats: list[float] = []

    async def heartbeat(stop: asyncio.Event) -> None:
        while not stop.is_set():
            beats.append(time.monotonic())
            await asyncio.sleep(0.01)

    async def main() -> Any:
        stop = asyncio.Event()
        beating = asyncio.ensure_future(heartbeat(stop))
        async with client(server, credentials={"apiKeyQuery": "k"}) as tasks:
            started = time.monotonic()
            task = await tasks.get_task(project_id="p", task_id="t")
            elapsed = time.monotonic() - started
        stop.set()
        await beating
        return task, elapsed

    task, elapsed = run(main())
    assert task["id"] == "t"
    assert elapsed >= 0.25
    # The loop kept running the heartbeat every ~10 ms while the request waited 300 ms for its response.
    assert len(beats) >= 10
    assert max(later - earlier for earlier, later in zip(beats, beats[1:], strict=False)) < 0.2


def test_cancelling_an_in_flight_call_propagates_without_retrying(server: FixtureServer) -> None:
    server.reset([scripted({"delayMs": 1000})])
    events: list[Any] = []

    async def main() -> None:
        async with client(server, credentials={"apiKeyQuery": "k"}, on_failure=events.append) as tasks:
            pending = asyncio.ensure_future(tasks.get_task(project_id="p", task_id="t"))
            await asyncio.sleep(0.05)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending

    run(main())
    assert len(server.requests) == 1
    assert [event["failure"] for event in events] == [{"kind": "aborted", "retryable": False, "attempt": 1}]


def test_cancels_during_the_backoff_between_attempts(server: FixtureServer) -> None:
    server.reset([scripted({"status": 503}), scripted({"status": 200})])
    events: list[Any] = []

    async def main() -> None:
        async with client(server, credentials={"apiKeyQuery": "k"}, retry={"base_delay": 5, "max_delay": 5}, on_failure=events.append) as tasks:
            pending = asyncio.ensure_future(tasks.get_task(project_id="p", task_id="t"))
            await asyncio.sleep(0.1)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending

    run(main())
    assert len(server.requests) == 1
    # The earlier retryable 503 does not make the cancellation retryable.
    assert [event["failure"] for event in events] == [{"kind": "aborted", "retryable": False, "attempt": 1}]


def test_times_out_and_cancels_while_a_credential_provider_never_settles(server: FixtureServer) -> None:
    async def never() -> str:
        await asyncio.Event().wait()
        return "k"

    async def main() -> None:
        started = time.monotonic()
        async with client(server, credentials={"apiKeyQuery": never}, timeout=0.05) as tasks:
            with pytest.raises(pkg.ApiTimeoutError) as caught:
                await tasks.get_task(project_id="p", task_id="t")
            assert caught.value.attempts == 0
        async with client(server, credentials={"apiKeyQuery": never}) as tasks:
            pending = asyncio.ensure_future(tasks.get_task(project_id="p", task_id="t"))
            await asyncio.sleep(0.02)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
        assert time.monotonic() - started < 1

    run(main())
    assert server.requests == []


def test_bounds_a_transport_that_ignores_cancellation(server: FixtureServer) -> None:
    finished = False

    async def stubborn(request: Any) -> Any:
        # Ignores cancellation until the test ends, so asyncio.run can still shut down.
        while True:
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                if finished:
                    raise

    async def main() -> None:
        nonlocal finished
        started = time.monotonic()
        async with client(server, transport=stubborn, timeout=0.05, retry={"max_attempts": 2}) as tasks:
            with pytest.raises(pkg.ApiTimeoutError) as caught:
                await tasks.get_health()
            assert caught.value.attempts == 2
        assert time.monotonic() - started < 1
        assert len(runtime._PENDING) == 2
        finished = True

    run(main())


def test_times_out_a_response_body_that_never_ends_and_closes_it() -> None:
    closed: list[bool] = []

    async def endless() -> AsyncIterator[bytes]:
        yield b"{"
        await asyncio.Event().wait()

    async def transport(request: Any) -> Any:
        async def close() -> None:
            closed.append(True)

        return pkg.TransportResponse(status=200, headers=[("content-type", "application/json")], body=endless(), close=close)

    async def main() -> None:
        async with pkg.TasksClient(transport=transport, timeout=0.05, retry={"max_attempts": 1}) as tasks:
            with pytest.raises(pkg.ApiTimeoutError):
                await tasks.get_health()
        await asyncio.sleep(0.05)

    run(main())
    assert closed == [True]


def test_closes_a_response_that_arrives_after_the_attempt_gave_up() -> None:
    closed: list[bool] = []
    reads: list[bool] = []

    async def body() -> AsyncIterator[bytes]:
        reads.append(True)
        yield b"ok"

    async def late(request: Any) -> Any:
        try:
            await asyncio.sleep(0.2)
        except asyncio.CancelledError:
            # A transport that finishes its response anyway.
            await asyncio.sleep(0.05)

        async def close() -> None:
            closed.append(True)

        return pkg.TransportResponse(status=200, headers=[("content-type", "text/plain")], body=body(), close=close)

    async def main() -> None:
        async with pkg.TasksClient(transport=late, timeout=0.03, retry={"max_attempts": 1}) as tasks:
            with pytest.raises(pkg.ApiTimeoutError):
                await tasks.get_health()
        await asyncio.sleep(0.15)

    run(main())
    assert closed == [True]
    assert reads == []


@pytest.mark.parametrize("ending", ["timeout", "cancellation"])
def test_closes_an_abandoned_response_at_once_when_its_body_ignores_cancellation(ending: str) -> None:
    closed: list[bool] = []
    released = asyncio.Event()

    async def stubborn() -> AsyncIterator[bytes]:
        yield b"{"
        # Ignores cancellation, and ends only once the response is closed.
        while not released.is_set():
            try:
                await released.wait()
            except asyncio.CancelledError:
                pass

    async def transport(request: Any) -> Any:
        async def close() -> None:
            closed.append(True)
            released.set()

        return pkg.TransportResponse(status=200, headers=[("content-type", "application/json")], body=stubborn(), close=close)

    async def main() -> None:
        try:
            async with pkg.TasksClient(transport=transport, timeout=0.05 if ending == "timeout" else 5, retry={"max_attempts": 1}) as tasks:
                started = time.monotonic()
                if ending == "timeout":
                    with pytest.raises(pkg.ApiTimeoutError):
                        await tasks.get_health()
                else:
                    call = asyncio.ensure_future(tasks.get_health())
                    await asyncio.sleep(0.05)
                    call.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await call
                assert time.monotonic() - started < 1
                await asyncio.sleep(0.05)
                # Closed without waiting for the reader, which the close then let finish: nothing is left pending.
                assert closed == [True]
                assert not runtime._PENDING
        finally:
            # Lets the reader end whatever happened, so a failure here cannot hang the event loop's shutdown.
            released.set()

    run(main())
    assert closed == [True]


@pytest.mark.parametrize("ending", ["timeout", "cancellation"])
def test_a_close_in_progress_when_the_attempt_is_abandoned_runs_to_completion(ending: str) -> None:
    log: list[str] = []
    released = asyncio.Event()

    async def transport(request: Any) -> Any:
        async def close() -> None:
            # Suspends once the body has been read, so the attempt is given up while its close is in progress.
            log.append("close-start")
            try:
                await released.wait()
            except asyncio.CancelledError:
                log.append("close-cancelled")
                raise
            log.append("close-done")

        return pkg.TransportResponse(status=200, headers=[("content-type", "application/json")], body=b"{}", close=close)

    async def main() -> None:
        try:
            async with pkg.TasksClient(transport=transport, timeout=0.05 if ending == "timeout" else 5, retry={"max_attempts": 1}) as tasks:
                started = time.monotonic()
                if ending == "timeout":
                    with pytest.raises(pkg.ApiTimeoutError):
                        await tasks.get_health()
                else:
                    call = asyncio.ensure_future(tasks.get_health())
                    await asyncio.sleep(0.05)
                    assert log == ["close-start"]
                    call.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await call
                assert time.monotonic() - started < 1
                await asyncio.sleep(0.02)
                assert log == ["close-start"]
                assert len(runtime._PENDING) == 1
                released.set()
                await asyncio.sleep(0.02)
                assert log == ["close-start", "close-done"]
                assert not runtime._PENDING
        finally:
            released.set()

    run(main())
    assert log == ["close-start", "close-done"]


# Destinations and transports.


def test_sends_every_operation_to_the_configured_base_url_never_to_spec_servers() -> None:
    urls: list[str] = []

    async def transport(request: Any) -> Any:
        urls.append(request.url)
        return pkg.TransportResponse(status=200, headers=[("content-type", "text/plain")], body=b"ok")

    async def main() -> None:
        assert await pkg.TasksClient(transport=transport).get_health() == "ok"
        await pkg.TasksClient(transport=transport, base_url="https://consumer.example.test/api/").get_health()
        slashes = "/" * 64 * 1024
        started = time.monotonic()
        await pkg.TasksClient(transport=transport, base_url=f"https://consumer.example.test{slashes}api{slashes}").get_health()
        assert time.monotonic() - started < 1

    run(main())
    assert urls[:2] == ["https://api.example.test/v1/health", "https://consumer.example.test/api/health"]
    assert urls[2] == f"https://consumer.example.test{'/' * 64 * 1024}api/health"
    assert CATALOG["servers"][0]["url"] == "https://spec-server.example.test/v1"


def test_rejects_base_urls_with_user_info_queries_fragments_dot_segments_or_other_schemes(server: FixtureServer) -> None:
    for base_url in ("https://u:p@api.example.test", "https://api.example.test/v1?x=1", "https://api.example.test/#f", "ftp://api.example.test", "/relative", "https://api.example.test/a/../b", "https://api.example.test/a b"):
        with pytest.raises(ValueError):
            pkg.TasksClient(base_url=base_url)
    with pytest.raises(ValueError, match="base_url is required"):
        direct_runtime(server, base_url=None)


def test_uses_an_injected_transport_for_every_attempt() -> None:
    seen: list[tuple[str, str]] = []

    async def transport(request: Any) -> Any:
        seen.append((request.method, request.url))
        if len(seen) == 1:
            return pkg.TransportResponse(status=503, headers=[])
        return pkg.TransportResponse(status=200, headers=[("content-type", "application/json")], body=b'{"items":[]}')

    async def main() -> Any:
        return await pkg.TasksClient(transport=transport, base_url="https://mock.example.test", credentials={"bearerAuth": "t"}).list_tasks(project_id="p")

    assert run(main()) == {"items": []}
    assert seen == [("GET", "https://mock.example.test/projects/p/tasks")] * 2


COOKIE = {"set-cookie": "session=secret; Path=/"}
HEALTH_WITH_COOKIE = {"status": 200, "headers": {"content-type": "text/plain", **COOKIE}, "body": "ok"}


def test_the_default_transport_never_stores_or_sends_response_cookies(server: FixtureServer) -> None:
    # Each response sets a cookie: the first call's, a retried 503's, and those of two concurrent calls.
    server.reset([scripted(HEALTH_WITH_COOKIE), scripted({"status": 503, "headers": COOKIE}), *[scripted(HEALTH_WITH_COOKIE)] * 3])

    async def main() -> None:
        async with client(server, credentials={"bearerAuth": "t"}) as tasks:
            assert await tasks.get_health() == "ok"
            assert await tasks.get_health() == "ok"
            assert await asyncio.gather(tasks.get_health(), tasks.get_health()) == ["ok", "ok"]
            await tasks.list_tasks(project_id="p")
            kept.extend(tasks._runtime._owned_transport._client.cookies.jar)

    kept: list[Any] = []
    run(main())
    assert len(server.requests) == 6
    assert [request.headers.get("cookie") for request in server.requests] == [None] * 6
    assert [request.headers.get("authorization") for request in server.requests] == [None] * 5 + ["Bearer t"]
    assert kept == []


def test_an_injected_httpx_client_adds_no_cookies_headers_parameters_or_auth(server: FixtureServer) -> None:
    import httpx

    task = {"status": 200, "headers": {"content-type": "application/json", **COOKIE}, "body": "{}"}
    server.reset([scripted(HEALTH_WITH_COOKIE), scripted({"status": 503, "headers": COOKIE}), scripted(task), scripted(HEALTH_WITH_COOKIE)])
    hooked: list[str] = []

    async def hook(request: httpx.Request) -> None:
        hooked.append(request.url.path)

    async def main() -> None:
        async with httpx.AsyncClient(
            cookies={"preset": "1"}, headers={"x-ambient": "1"}, params={"ambient": "1"}, auth=("user", "password"), event_hooks={"request": [hook]}
        ) as shared:
            async with client(server, transport=pkg.HttpxTransport(shared), credentials={"apiKeyQuery": "k"}) as tasks:
                assert await tasks.get_health() == "ok"
                await tasks.get_task(project_id="p", task_id="t")
                await tasks.get_health()
            assert not shared.is_closed

    run(main())
    assert [(request.path, request.query) for request in server.requests] == [("/v1/health", ""), ("/v1/projects/p/tasks/t", "key=k"), ("/v1/projects/p/tasks/t", "key=k"), ("/v1/health", "")]
    for request in server.requests:
        assert "cookie" not in request.headers
        assert "x-ambient" not in request.headers
        assert "authorization" not in request.headers
    # The client's transport configuration, such as its event hooks, still applies.
    assert len(hooked) == 4


def test_classifies_a_transport_failure_as_a_network_error() -> None:
    failure = ConnectionError("refused")

    async def transport(request: Any) -> Any:
        raise failure

    async def nothing(request: Any) -> Any:
        return None

    async def main() -> None:
        with pytest.raises(pkg.ApiError) as caught:
            await pkg.TasksClient(transport=transport, retry={"max_attempts": 1}).get_health()
        assert caught.value.kind == "network"
        assert caught.value.__cause__ is failure
        with pytest.raises(pkg.ApiError) as invalid:
            await pkg.TasksClient(transport=nothing, retry={"max_attempts": 1}).get_health()
        assert invalid.value.kind == "network"
        assert "instead of a TransportResponse" in str(invalid.value)

    run(main())


def test_resolves_credential_functions_per_request(server: FixtureServer) -> None:
    calls = 0

    async def token() -> str:
        nonlocal calls
        calls += 1
        return f"token-{calls}"

    async def main() -> None:
        async with client(server, credentials={"bearerAuth": token}) as tasks:
            await tasks.replace_task(project_id="p", task_id="t", body={"title": "x"})
            await tasks.replace_task(project_id="p", task_id="t", body={"title": "x"})

    run(main())
    assert [request.headers["authorization"] for request in server.requests] == ["Bearer token-1", "Bearer token-2"]


# Failure observation.


def test_observes_nothing_and_sends_nothing_else_without_a_hook() -> None:
    urls: list[str] = []

    async def transport(request: Any) -> Any:
        urls.append(request.url)
        return pkg.TransportResponse(status=500, headers=[])

    async def main() -> None:
        with pytest.raises(pkg.ApiHttpError):
            await pkg.TasksClient(transport=transport, retry={"max_attempts": 1}, credentials={"apiKeyQuery": "k"}).get_task(project_id="p", task_id="t")

    run(main())
    assert urls == ["https://api.example.test/v1/projects/p/tasks/t?key=k"]


def test_emits_observations_without_urls_values_or_credentials(server: FixtureServer) -> None:
    events: list[Any] = []

    async def main() -> None:
        async with client(server, credentials={"apiKeyQuery": "secret-key-123"}, on_failure=events.append) as tasks:
            server.reset([scripted({"status": 503})] * 3)
            with pytest.raises(pkg.ApiHttpError):
                await tasks.get_task(project_id="project-secret", task_id="t")
            with pytest.raises(pkg.ApiError):
                await tasks.get_task(project_id="", task_id="t")
            server.reset([scripted({"delayMs": 500})])
            with pytest.raises(pkg.ApiTimeoutError):
                await tasks.get_task(project_id="p", task_id="t", request_options={"timeout": 0.02, "retry": {"max_attempts": 1}})

    run(main())
    assert [(event["failure"]["kind"], event["failure"].get("httpStatus"), event["failure"]["attempt"], event["failure"]["retryable"]) for event in events] == [
        ("http", 503, 3, True),
        ("validation", None, 1, False),
        ("timeout", None, 1, True),
    ]
    for event in events:
        assert event["operation"] == {"id": "tasks.get", "name": "getTask", "method": "get", "pathTemplate": "/projects/{projectId}/tasks/{taskId}"}
        assert event["release"]["sdk"] == {"target": "python", "package": "example-tasks-sdk", "version": "1.0.0"}
        assert "secret" not in json.dumps(event) and "127.0.0.1" not in json.dumps(event)
    assert len({event["eventId"] for event in events}) == 3
    path = os.environ.get("APIFN_SDK_EVENTS_OUT")
    if path:
        Path(path).write_text(json.dumps(events), "utf-8")


def test_never_lets_an_observer_change_the_outcome(server: FixtureServer) -> None:
    observed: list[str] = []

    def raising(event: Any) -> None:
        observed.append("raising")
        raise RuntimeError("observer failed")

    async def failing(event: Any) -> None:
        observed.append("async")
        raise RuntimeError("async observer failed")

    async def main() -> None:
        for hook in (raising, failing):
            server.reset([scripted({"status": 404, "headers": {"content-type": "application/problem+json"}, "body": '{"title":"x","status":404}'})])
            async with client(server, credentials={"apiKeyQuery": "k"}, on_failure=hook) as tasks:
                with pytest.raises(pkg.ApiHttpError) as caught:
                    await tasks.get_task(project_id="p", task_id="t")
                assert caught.value.status == 404
        await asyncio.sleep(0.02)

    loop_errors: list[Any] = []

    async def guarded() -> None:
        asyncio.get_running_loop().set_exception_handler(lambda loop, context: loop_errors.append(context))
        await main()

    run(guarded())
    assert observed == ["raising", "async"]
    assert loop_errors == []


# Installation.


def test_runs_from_the_installed_distribution_with_its_provenance() -> None:
    module_file = Path(pkg.__file__).resolve()
    assert "site-packages" in module_file.parts, module_file
    manifest = json.loads((module_file.parent / "apifn.sdk-manifest.json").read_text("utf-8"))
    assert manifest["target"]["id"] == "python"
    assert manifest["catalog"]["digest"] == client_module()._METADATA.catalog_digest
    expected = os.environ.get("APIFN_SDK_CATALOG_DIGEST")
    if expected:
        assert manifest["catalog"]["digest"] == expected
    assert importlib.metadata.version("example-tasks-sdk") == "1.0.0"
    assert sys.version_info >= (3, 10)
    custom = os.environ.get("APIFN_SDK_CUSTOM_EXPORT")
    if custom:
        assert getattr(pkg, custom)() == "custom code survives regeneration"


def test_outcomes_normalize_like_the_typescript_harness() -> None:
    # The cross-language comparison relies on this shape.
    assert outcome_of(b"abc") == {"ok": True, "result": {"$bytes": "YWJj"}}
    assert operation_name("tasks.attachment.download") == "download_attachment"
    assert kwargs_for("tasks.list", {"parameters": {"header": {"X-Request-Id": "r"}}}) == {"x_request_id": "r"}
