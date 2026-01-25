from __future__ import annotations

from typing import List

from superfunctions.http import HttpMethod, Route

from .handlers import HttpHandlers


def create_routes(lang) -> List[Route]:
    handlers = HttpHandlers(lang)
    return [
        Route(method=HttpMethod.GET, path="/health", handler=handlers.health),
        Route(method=HttpMethod.POST, path="/complete", handler=handlers.complete),
        Route(method=HttpMethod.POST, path="/chat", handler=handlers.chat),
        Route(method=HttpMethod.POST, path="/embed", handler=handlers.embed),
        Route(method=HttpMethod.GET, path="/traces", handler=handlers.traces),
        Route(method=HttpMethod.POST, path="/feedback", handler=handlers.feedback),
    ]

