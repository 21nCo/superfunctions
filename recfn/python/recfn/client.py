"""HTTP client for RecFn API."""

from __future__ import annotations

from typing import Any, Dict, Optional
from urllib.parse import quote

import httpx


class RecFnHttpClient:
    """HTTP client with Bearer auth and envelope handling."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Make JSON request and return parsed envelope or error.

        Returns dict with either:
          - ok=True, data=<response data>
          - ok=False, error={code, message, details}
        """
        url = f"{self.base_url}{path}" if path.startswith("/") else f"{self.base_url}/{path}"
        hdrs = {**self._headers(), **(headers or {})}
        if body is not None:
            hdrs["Content-Type"] = "application/json"

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.request(
                method,
                url,
                json=body,
                headers=hdrs,
            )

        content_type = resp.headers.get("content-type", "")
        is_json = "application/json" in content_type

        if not resp.is_success:
            if is_json:
                try:
                    data = resp.json()
                    if isinstance(data, dict) and data.get("ok") is False and "error" in data:
                        err = data["error"]
                        return {
                            "ok": False,
                            "error": {
                                "code": err.get("code", "HTTP_ERROR"),
                                "message": err.get("message", resp.text),
                                "details": err.get("details", {}),
                            },
                        }
                except Exception:
                    pass
            return {
                "ok": False,
                "error": {
                    "code": "HTTP_ERROR",
                    "message": f"HTTP {resp.status_code}: {resp.reason_phrase}",
                    "details": {},
                },
            }

        if is_json:
            data = resp.json()
            if isinstance(data, dict) and data.get("ok") is True:
                return {"ok": True, "data": data.get("data")}
            if isinstance(data, dict) and data.get("ok") is False:
                err = data.get("error", {})
                return {
                    "ok": False,
                    "error": {
                        "code": err.get("code", "PARSE_ERROR"),
                        "message": err.get("message", "Unexpected response"),
                        "details": err.get("details", {}),
                    },
                }

        return {
            "ok": False,
            "error": {
                "code": "PARSE_ERROR",
                "message": "Unexpected response format",
                "details": {},
            },
        }

    async def request_raw(
        self,
        method: str,
        path: str,
        *,
        headers: Optional[Dict[str, str]] = None,
    ) -> httpx.Response:
        """Make raw request for non-JSON responses (e.g. transcript srt/vtt/text)."""
        url = f"{self.base_url}{path}" if path.startswith("/") else f"{self.base_url}/{path}"
        hdrs = {**self._headers(), **(headers or {})}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            return await client.request(method, url, headers=hdrs)

    def get_ws_url(self, path: str, token: Optional[str] = None) -> str:
        """Build WebSocket URL with optional token."""
        base = self.base_url.replace("http://", "ws://").replace("https://", "wss://")
        url = f"{base}{path}" if path.startswith("/") else f"{base}/{path}"
        t = token or self.api_key
        if t:
            sep = "&" if "?" in url else "?"
            return f"{url}{sep}token={quote(t, safe='')}"
        return url
