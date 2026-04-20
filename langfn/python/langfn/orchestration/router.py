from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict

from .chain import Chain


def create_router_chain(
    *,
    routes: Dict[str, Callable[[Any], Awaitable[Any]]],
    router: Callable[[Any], Awaitable[str]],
) -> Chain[Any, Any]:
    return Chain.router(routes=routes, router=router)
