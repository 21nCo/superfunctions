import asyncio
import json

import pytest
from sqlalchemy import MetaData, create_engine
from superfunctions.http import RouteContext
from superfunctions_sqlalchemy import SQLAlchemyAdapter

from catchfn import (
    BugReportEvent,
    CatchFnService,
    create_catchfn_router,
    get_sqlalchemy_table,
)


def test_sqlite_reopen_scope_filters_and_retention(tmp_path):
    async def run():
        path = "sqlite:///" + str(tmp_path / "bugs.sqlite")
        engine = create_engine(path)
        metadata = MetaData()
        get_sqlalchemy_table(metadata)
        metadata.create_all(engine)
        adapter = SQLAlchemyAdapter(engine)
        first = CatchFnService(adapter, app="first", now=lambda: 0)
        second = CatchFnService(adapter, app="second", now=lambda: 0)
        report = BugReportEvent(
            id="one",
            timestamp=9999999999999,
            title="Bug",
            severity="high",
            tags=["ui_%"],
            metadata={"token": "secret", "nested": [1, True]},
        )
        saved = await first.create_bug(report)
        assert saved.metadata["token"] == "[REDACTED]"
        assert (await first.create_bug(report)).model_dump() == saved.model_dump()
        with pytest.raises(ValueError, match="already exists"):
            await first.create_bug(report.model_copy(update={"title": "different"}))
        assert await second.get_bug("one") is None
        assert len(await first.list_bugs(tags=["ui_%"])) == 1
        assert len(await first.list_bugs(tags=["ui"])) == 0
        engine.dispose()
        reopened = CatchFnService(
            SQLAlchemyAdapter(create_engine(path)),
            app="first",
            now=lambda: 3 * 86400000,
        )
        assert (await reopened.get_bug("one")).model_dump() == saved.model_dump()
        assert await reopened.cleanup(1) == 1
        assert await reopened.get_bug("one") is None

    asyncio.run(run())


def test_shared_http_boundaries(tmp_path):
    class Request:
        def __init__(self, body, authorized=True):
            self._body = body
            self.headers = {"authorization": "Bearer test"} if authorized else {}

        async def body(self):
            return self._body

    async def run():
        engine = create_engine("sqlite:///" + str(tmp_path / "http.sqlite"))
        metadata = MetaData()
        get_sqlalchemy_table(metadata)
        metadata.create_all(engine)
        service = CatchFnService(SQLAlchemyAdapter(engine))
        router = create_catchfn_router(
            service,
            authorize=lambda request: (
                request.headers.get("authorization") == "Bearer test"
            ),
            max_body_bytes=1024,
        )
        handler = router.routes[0].handler
        context = RouteContext(url="http://local/bugs", method="POST")
        payload = json.dumps(
            {"id": "one", "timestamp": 1, "title": "Bug", "severity": "high"}
        ).encode()
        assert (await handler(Request(payload, False), context)).status == 401
        assert (await handler(Request(b"{"), context)).status == 400
        assert (await handler(Request(payload), context)).status == 201
        assert (await handler(Request(payload), context)).status == 201
        assert (await handler(Request(b"x" * 2048), context)).status == 413
        bad = RouteContext(
            url="http://local/bugs?limit=bad", method="GET", query={"limit": "bad"}
        )
        assert (await router.routes[2].handler(Request(b""), bad)).status == 400
        engine.dispose()

    asyncio.run(run())
