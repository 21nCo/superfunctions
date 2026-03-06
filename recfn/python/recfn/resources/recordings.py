"""Recordings resource."""

from __future__ import annotations

from ..client import RecFnHttpClient
from ..types import _parse_recording


def create_recordings_resource(client: RecFnHttpClient) -> object:
    """Create recordings resource."""

    class RecordingsResource:
        async def list(self, bot_id: str) -> dict:
            res = await client.request("GET", f"/api/v1/bots/{bot_id}/recordings")
            if res.get("ok") and res.get("data"):
                data = res["data"]
                res["data"] = {
                    "recordings": [_parse_recording(r) for r in data.get("recordings", [])],
                }
            return res

        async def get(self, recording_id: str) -> dict:
            res = await client.request("GET", f"/api/v1/recordings/{recording_id}")
            if res.get("ok") and res.get("data"):
                res["data"] = _parse_recording(res["data"])
            return res

        async def download_url(self, recording_id: str) -> dict:
            res = await client.request("GET", f"/api/v1/recordings/{recording_id}")
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

    return RecordingsResource()
