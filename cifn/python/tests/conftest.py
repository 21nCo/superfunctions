"""Shared fixtures for cifn tests."""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import httpx

from cifn.client import CiFnClient, CiFnConfig


def mock_transport(
    responses: Dict[Tuple[str, str], Tuple[int, Any]],
) -> httpx.AsyncBaseTransport:
    """Create an httpx MockTransport that returns canned responses by (method, path)."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        key = (request.method, path)
        if key in responses:
            status, body = responses[key]
            if isinstance(body, dict):
                return httpx.Response(status, json=body)
            return httpx.Response(status, content=body)
        return httpx.Response(
            404, json={"ok": False, "error": {"code": "NOT_FOUND", "message": "Not found"}}
        )

    return httpx.MockTransport(handler)


def make_client(
    transport: httpx.AsyncBaseTransport,
    base_url: str = "http://test",
    api_key: Optional[str] = None,
) -> CiFnClient:
    """Create a CiFnClient with the given mock transport."""
    config = CiFnConfig(base_url=base_url, api_key=api_key)
    return CiFnClient(config, transport=transport)
