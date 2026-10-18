"""Shared HTTP route definitions for framework adapters."""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable
from typing import Any, cast

from pydantic import ValidationError
from superfunctions.http import (
    HttpMethod,
    Request,
    Response,
    Route,
    RouteContext,
    RouterOptions,
)

from .service import CatchFnConflictError, CatchFnService, CatchFnValidationError
from .types import BugReportEvent


def create_catchfn_router(
    service: CatchFnService,
    *,
    authorize: Callable[[Request], Any] | None = None,
    max_body_bytes: int = 262144,
) -> RouterOptions:
    if (
        isinstance(max_body_bytes, bool)
        or not isinstance(max_body_bytes, int)
        or max_body_bytes < 1
    ):
        raise ValueError("Invalid max_body_bytes")

    def response(body: Any, status: int = 200) -> Response:
        return Response(
            body=body, status=status, headers={"content-type": "application/json"}
        )

    def guarded(handler: Callable[..., Any]) -> Callable[..., Any]:
        async def run(req: Request, ctx: RouteContext) -> Response:
            try:
                if authorize is not None:
                    allowed = authorize(req)
                    if inspect.isawaitable(allowed):
                        allowed = await allowed
                    if not allowed:
                        return response({"error": "Unauthorized"}, 401)
                return cast(Response, await handler(req, ctx))
            except CatchFnConflictError:
                return response({"error": "Bug id already exists"}, 409)
            except (CatchFnValidationError, ValidationError, ValueError, TypeError):
                return response({"error": "Invalid request"}, 400)
            except Exception:  # noqa: BLE001 - do not expose adapter failures at the HTTP boundary
                return response({"error": "Internal Server Error"}, 500)

        return run

    async def create_bug(req: Request, ctx: RouteContext) -> Response:
        body = await req.body()
        if len(body) > max_body_bytes:
            return response({"error": "Payload too large"}, 413)
        report = BugReportEvent.model_validate(json.loads(body))
        saved = await service.create_bug(report)
        return response(saved.model_dump(mode="json", exclude_none=True), 201)

    async def get_bug(req: Request, ctx: RouteContext) -> Response:
        bug = await service.get_bug(ctx.params["id"])
        return (
            response(bug.model_dump(mode="json", exclude_none=True))
            if bug
            else response({"error": "Bug not found"}, 404)
        )

    async def list_bugs(req: Request, ctx: RouteContext) -> Response:
        query = ctx.query
        filters: dict[str, Any] = {
            field: query[field]
            for field in ("app", "severity", "sessionId", "replayId", "issueId")
            if field in query
        }
        if "from" in query:
            filters["from_time"] = float(query["from"])
        if "to" in query:
            filters["to_time"] = float(query["to"])
        if "tag" in query:
            filters["tags"] = (
                query["tag"] if isinstance(query["tag"], list) else [query["tag"]]
            )
        bugs = await service.list_bugs(
            int(query.get("limit", 50)), int(query.get("offset", 0)), **filters
        )
        return response(
            [bug.model_dump(mode="json", exclude_none=True) for bug in bugs]
        )

    return RouterOptions(
        basePath="",
        routes=[
            Route(method=HttpMethod.POST, path="/bugs", handler=guarded(create_bug)),
            Route(method=HttpMethod.GET, path="/bugs/:id", handler=guarded(get_bug)),
            Route(method=HttpMethod.GET, path="/bugs", handler=guarded(list_bugs)),
        ],
    )
