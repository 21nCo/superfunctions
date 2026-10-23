from __future__ import annotations

from typing import List, Optional

from superfunctions.http import AuthRouteMeta, HttpMethod, Route, RouteMeta

from .auth import LangFnAuthConfig, create_auth_middleware
from .handlers import HttpHandlers
from .rate_limit import LangFnRateLimitConfig, create_rate_limit_middleware


def create_routes(
    lang,
    *,
    auth: Optional[LangFnAuthConfig] = None,
    rate_limit: Optional[LangFnRateLimitConfig] = None,
) -> List[Route]:
    handlers = HttpHandlers(lang)

    def secure(route_id: str):
        return [
            create_auth_middleware(auth),
            create_rate_limit_middleware(route_id=route_id, config=rate_limit),
        ]

    return [
        Route(
            method=HttpMethod.GET,
            path="/health",
            handler=handlers.health,
            meta=RouteMeta(auth=AuthRouteMeta(mode="none")),
        ),
        Route(
            method=HttpMethod.POST,
            path="/complete",
            handler=handlers.complete,
            middleware=secure("/complete"),
            meta=RouteMeta(auth=AuthRouteMeta(mode="hybrid")),
        ),
        Route(
            method=HttpMethod.POST,
            path="/chat",
            handler=handlers.chat,
            middleware=secure("/chat"),
            meta=RouteMeta(auth=AuthRouteMeta(mode="hybrid")),
        ),
        Route(
            method=HttpMethod.POST,
            path="/stream",
            handler=handlers.stream,
            middleware=secure("/stream"),
            meta=RouteMeta(auth=AuthRouteMeta(mode="hybrid")),
        ),
        Route(
            method=HttpMethod.POST,
            path="/embed",
            handler=handlers.embed,
            middleware=secure("/embed"),
            meta=RouteMeta(auth=AuthRouteMeta(mode="hybrid")),
        ),
        Route(
            method=HttpMethod.GET,
            path="/traces",
            handler=handlers.traces,
            middleware=secure("/traces"),
            meta=RouteMeta(auth=AuthRouteMeta(mode="hybrid")),
        ),
        Route(
            method=HttpMethod.POST,
            path="/feedback",
            handler=handlers.feedback,
            middleware=secure("/feedback"),
            meta=RouteMeta(auth=AuthRouteMeta(mode="hybrid")),
        ),
    ]
