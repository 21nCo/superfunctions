"""Recordings resource."""

from __future__ import annotations

from typing import Any

from ..client import RecFnHttpClient
from ..types import _parse_recording


class RecordingsResource:
    def __init__(self, client: RecFnHttpClient) -> None:
        self._client = client

    async def list(self, bot_id: str) -> dict:
        res = await self._client.request("GET", f"/api/v1/bots/{bot_id}/recordings")
        if res.get("ok") and res.get("data"):
            data = res["data"]
            res["data"] = {
                "recordings": [_parse_recording(r) for r in data.get("recordings", [])],
            }
        return res

    async def get(self, recording_id: str) -> dict:
        res = await self._client.request("GET", f"/api/v1/recordings/{recording_id}")
        if res.get("ok") and res.get("data"):
            res["data"] = _parse_recording(res["data"])
        return res

    async def download_url(self, recording_id: str) -> dict:
        res = await self._client.request("GET", f"/api/v1/recordings/{recording_id}")
        if res.get("ok") and res.get("data"):
            rec = res["data"]
            url = rec.get("downloadUrl") if isinstance(rec, dict) else getattr(rec, "download_url", None)
            if url:
                return {"ok": True, "data": url}
            return {
                "ok": False,
                "error": {
                    "code": "RECORDING_NOT_FOUND",
                    "message": "Download URL not available",
                    "details": {},
                },
            }
        return res

    async def download(self, recording_id: str) -> dict:
        url_res = await self.download_url(recording_id)
        if not url_res.get("ok"):
            return url_res
        import httpx
        async with httpx.AsyncClient() as hc:
            resp = await hc.get(url_res["data"])
        if not resp.is_success:
            return {
                "ok": False,
                "error": {
                    "code": "RECORDING_NOT_FOUND",
                    "message": f"Download failed: {resp.status_code}",
                    "details": {},
                },
            }
        return {"ok": True, "data": resp}

    async def upload(
        self,
        file_bytes: bytes | bytearray | memoryview,
        options: dict[str, Any],
    ) -> dict:
        bot_id = options.get("bot_id") or options.get("botId")
        if not isinstance(bot_id, str) or not bot_id:
            return {
                "ok": False,
                "error": {
                    "code": "BAD_REQUEST",
                    "message": "bot_id is required.",
                    "details": {},
                },
            }

        transcribe = options.get("transcribe") is True
        path = (
            f"/api/v1/recordings/upload?botId={bot_id}"
            f"{'&transcribe=true' if transcribe else ''}"
        )
        payload = bytes(file_bytes)
        resp = await self._client.request_multipart(
            "POST",
            path,
            files={
                "file": (
                    options.get("filename", "recording.webm"),
                    payload,
                    options.get("content_type", "application/octet-stream"),
                )
            },
        )

        if not resp.is_success:
            try:
                data = resp.json()
                err = data.get("error", {})
                return {
                    "ok": False,
                    "error": {
                        "code": err.get("code", "HTTP_ERROR"),
                        "message": err.get("message", f"HTTP {resp.status_code}"),
                        "details": err.get("details", {}),
                    },
                }
            except Exception:
                return {
                    "ok": False,
                    "error": {
                        "code": "HTTP_ERROR",
                        "message": f"HTTP {resp.status_code}",
                        "details": {},
                    },
                }

        data = resp.json()
        if isinstance(data, dict) and data.get("ok") is True and data.get("data"):
            return {"ok": True, "data": _parse_recording(data["data"])}
        if isinstance(data, dict) and data.get("ok") is False and data.get("error"):
            return {"ok": False, "error": data["error"]}
        return {
            "ok": False,
            "error": {
                "code": "PARSE_ERROR",
                "message": "Unexpected response format",
                "details": {},
            },
        }


def create_recordings_resource(client: RecFnHttpClient) -> RecordingsResource:
    """Create recordings resource."""
    return RecordingsResource(client)
