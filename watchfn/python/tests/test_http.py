import asyncio
from datetime import datetime, timedelta, timezone
import json
import threading
from types import SimpleNamespace

import pytest
from superfunctions.auth import AuthSession, AuthSubject
from superfunctions.http import RouteContext
from watchfn import WatchFn
from watchfn.http.handlers import HttpHandlers


def session(scopes, **kwargs):
    return AuthSession(id="actor", type="api-key", subject=AuthSubject(actor_id="actor", actor_type="api-key"), scopes=scopes, **kwargs)


class Provider:
    async def authenticate(self, request):
        token = {key.lower(): value for key, value in request.headers.items()}.get("authorization")
        if token == "Bearer broken":
            raise RuntimeError("secret provider detail")
        scopes = {"Bearer writer": ["watchfn:ingest"], "Bearer reader": ["watchfn:query"]}.get(token)
        return session(scopes) if scopes else None


@pytest.fixture(params=["fastapi", "flask"])
def http(request):
    watch = WatchFn("test", auth={"provider": Provider(), "apiKey": "legacy"})
    # No collectors: exercise the actual batcher lifecycle without unrelated events.
    watch.system_metrics.start = lambda: None
    watch.process_metrics.start = lambda: None
    watch.start()
    request.addfinalizer(watch.stop)
    if request.param == "fastapi":
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from watchfn.adapters.fastapi import create_fastapi_router
        app = FastAPI()
        app.include_router(create_fastapi_router(watch))
        client = TestClient(app)
    else:
        from flask import Flask
        from watchfn.adapters.flask import create_flask_blueprint
        app = Flask(__name__)
        app.register_blueprint(create_flask_blueprint(watch))
        client = app.test_client()
    def post(path, value, token="writer", raw=False):
        headers = {"authorization": "Bearer " + token, "content-type": "application/json"}
        body = value if raw else json.dumps(value)
        if request.param == "fastapi":
            return client.post("/watch/" + path, content=body, headers=headers)
        return client.post("/watch/" + path, data=body, headers=headers)
    def body(response):
        return response.json() if request.param == "fastapi" else response.get_json()
    try:
        yield watch, post, body
    finally:
        watch.stop()
        if request.param == "fastapi":
            client.close()


def test_real_adapter_scope_and_completed_storage(http):
    watch, post, body = http
    for token, status in [("reader", 403), ("legacy", 401), ("broken", 503)]:
        response = post("ingest", "invalid", token, raw=True)
        assert response.status_code == status
        assert "secret" not in str(body(response))
    assert post("query", {}, "writer").status_code == 403
    assert post("ingest", {"events": [{"name": "event", "properties": {"unicode": "✓"}}]}).status_code == 202
    assert len(watch.storage.query()) == 1  # Already stored, not merely buffered.
    watch.track("local")
    response = post("query", {}, "reader")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert [event["name"] for event in body(response)["results"]] == ["event", "local"]
    assert isinstance(body(response)["results"][0]["timestamp"], str)
    assert len(body(post("query", {"metric": "event", "limit": 1}, "reader"))["results"]) == 1
    assert len(watch.query()) == 2  # No duplicated HTTP event through the batcher.


def test_validation_and_failures_are_not_success(http):
    watch, post, body = http
    for value in [[], [{"name": "good"}, {"name": ""}], {"name": "x", "type": "bug_report"}, {"name": "x", "properties": []}, {"name": "x", "ignored": True}]:
        assert post("ingest", value).status_code == 400
        assert watch.storage.query() == []
    assert post("ingest", {"name": "x", "properties": {"huge": "x" * 65536}}).status_code == 413
    assert post("ingest", [{"name": "x"}] * 501).status_code == 400
    for value in [{"limit": True}, {"limit": 1001}, {"metric": []}, {"aggregation": "sum"}]:
        assert post("query", value, "reader").status_code == 400
    original = watch.storage.add_batch
    watch.storage.add_batch = lambda events: (_ for _ in ()).throw(RuntimeError("private database URL"))
    try:
        response = post("ingest", {"name": "x"})
        assert response.status_code == 503
        assert "private" not in str(body(response))
    finally:
        watch.storage.add_batch = original
    watch.stop()
    assert post("ingest", {"name": "stopped"}).status_code == 503
    watch.config.storage = "database"
    assert post("query", {}, "reader").status_code == 503


@pytest.mark.parametrize("auth", [{"enabled": "false"}, {"provider": {}}, {"enabled": True}, {"apiKey": " "}, {"enabled": False, "apiKey": "key"}, {"provider": Provider(), "enabled": False}, {"apiKye": "typo"}])
def test_invalid_auth_configuration(auth):
    with pytest.raises(ValueError):
        WatchFn("bad", auth=auth)


@pytest.mark.asyncio
async def test_expiry_invalid_sessions_and_auth_before_body():
    context = RouteContext(url="http://local/query", method="POST")
    class Request:
        headers = {"authorization": "Bearer legacy"}
        async def body(self):
            raise AssertionError("Unauthorized body must not be read")
    for value in [None, {}, session([]), session(["*"]), session(["watchfn:query"], expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)), session(["watchfn:query"], expires_at=datetime.now())]:
        async def authenticate(request):
            return value
        handler = HttpHandlers(WatchFn("test", auth={"provider": SimpleNamespace(authenticate=authenticate), "apiKey": "legacy"}))
        assert (await handler.query(Request(), context)).status in [401, 403]


@pytest.mark.asyncio
async def test_legacy_and_declared_body_limit():
    watch = WatchFn("test", auth={"apiKey": "key"})
    handler = HttpHandlers(watch)
    request = SimpleNamespace(headers={"X-API-KEY": "key", "Content-Length": "8388609"})
    assert (await handler.ingest(request, RouteContext(url="http://local", method="POST"))).status == 413
    request.headers = {"Authorization": "Bearer wrong"}
    assert (await handler.authorize(request, "watchfn:query")).status == 401
    request.headers = {"Authorization": "Bearer key"}
    assert await handler.authorize(request, "watchfn:query") is None


def test_no_acknowledgement_before_storage_returns(http):
    from concurrent.futures import ThreadPoolExecutor
    watch, post, _ = http
    entered, release = threading.Event(), threading.Event()
    original = watch.storage.add_batch
    def store(events):
        entered.set()
        assert release.wait(5)
        original(events)
    watch.storage.add_batch = store
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(post, "ingest", {"name": "committed"})
        try:
            assert entered.wait(5)
            assert not pending.done()
            assert watch.storage.query() == []
        finally:
            release.set()
        assert pending.result(timeout=5).status_code == 202
    watch.storage.add_batch = original
    assert len(watch.storage.query()) == 1


@pytest.mark.asyncio
async def test_actual_body_bytes_and_query_output_bounds():
    watch = WatchFn("test")
    handler = HttpHandlers(watch)
    context = RouteContext(url="http://local", method="POST")
    class Request:
        headers = {}
        async def body(self):
            return b" " * (8 * 1024 * 1024 + 1)
    assert (await handler.ingest(Request(), context)).status == 413
    class Query:
        headers = {}
        async def body(self):
            return b"{}"
    from watchfn.models import Event
    watch.storage.add(Event(type="track", name="large", properties={"large": "x" * (8 * 1024 * 1024)}))
    assert (await handler.query(Query(), context)).status == 503


def test_memory_retention_snapshot():
    from watchfn.storage.memory_storage import MemoryStorage
    from watchfn.models import Event
    storage = MemoryStorage(2)
    storage.add_batch([Event(type="track", name=str(index)) for index in range(3)])
    assert [item.name for item in storage.query()] == ["1", "2"]
    snapshot = storage.query()
    snapshot[0].name = "changed"
    snapshot.clear()
    assert [item.name for item in storage.query()] == ["1", "2"]
    with pytest.raises(ValueError):
        MemoryStorage(0)
