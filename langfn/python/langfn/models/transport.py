from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import httpx


_CLIENT_CACHE: dict[Tuple[str, Tuple[Tuple[str, str], ...], float, Optional[int]], httpx.AsyncClient] = {}


def _normalize_base_url(base_url: str) -> str:
    return base_url[:-1] if base_url.endswith("/") else base_url


def get_async_client(
    *,
    base_url: str,
    headers: Dict[str, str],
    timeout: float,
    transport: Optional[Any] = None,
) -> httpx.AsyncClient:
    key = (
        _normalize_base_url(base_url),
        tuple(sorted(headers.items())),
        timeout,
        id(transport) if transport is not None else None,
    )
    cached = _CLIENT_CACHE.get(key)
    if cached is None:
        cached = httpx.AsyncClient(
            base_url=_normalize_base_url(base_url),
            headers=headers,
            timeout=timeout,
            transport=transport,
        )
        _CLIENT_CACHE[key] = cached
    return cached
