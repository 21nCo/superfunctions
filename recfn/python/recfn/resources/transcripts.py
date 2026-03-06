"""Transcripts resource."""

from __future__ import annotations

from typing import Optional

from ..client import RecFnHttpClient
from ..types import Transcript, _parse_segment, _parse_transcript


def create_transcripts_resource(client: RecFnHttpClient) -> object:
    """Create transcripts resource."""

    class TranscriptsResource:
        async def get(
            self,
            recording_id: str,
            *,
            format: str = "json",
            redact: bool = False,
        ) -> dict:
            params: list[str] = []
            if format:
                params.append(f"format={format}")
            if redact:
                params.append("redact=true")
            qs = "&".join(params)
            path = f"/api/v1/recordings/{recording_id}/transcript?{qs}" if qs else f"/api/v1/recordings/{recording_id}/transcript"
            resp = await client.request_raw("GET", path)
            if not resp.is_success:
                try:
                    j = resp.json()
                    err = j.get("error", {})
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
            if format == "json":
                j = resp.json()
                if isinstance(j, dict) and j.get("ok") is True and j.get("data"):
                    return {"ok": True, "data": _parse_transcript(j["data"])}
                if isinstance(j, dict) and j.get("ok") is False and j.get("error"):
                    return {"ok": False, "error": j["error"]}
            return {"ok": True, "data": resp.text}

        async def transcribe(
            self,
            recording_id: str,
            *,
            asr_provider: Optional[str] = None,
            language: Optional[str] = None,
        ) -> dict:
            body: dict = {}
            if asr_provider:
                body["asrProvider"] = asr_provider
            if language:
                body["language"] = language
            return await client.request(
                "POST",
                f"/api/v1/recordings/{recording_id}/transcribe",
                body=body or {},
            )

        async def search(
            self,
            q: str,
            *,
            bot_id: Optional[str] = None,
            limit: Optional[int] = None,
            cursor: Optional[str] = None,
        ) -> dict:
            params = [f"q={q}"]
            if bot_id:
                params.append(f"botId={bot_id}")
            if limit is not None:
                params.append(f"limit={limit}")
            if cursor:
                params.append(f"cursor={cursor}")
            path = f"/api/v1/transcripts/search?{'&'.join(params)}"
            res = await client.request("GET", path)
            if res.get("ok") and res.get("data"):
                data = res["data"]
                results = data.get("results", [])
                res["data"] = {
                    "results": [
                        {
                            "recording_id": r.get("recordingId"),
                            "bot_id": r.get("botId"),
                            "segment": _parse_segment(r.get("segment", {})),
                            "context": r.get("context"),
                        }
                        for r in results
                    ],
                    "next_cursor": data.get("nextCursor"),
                }
            return res

        def stream(self, bot_id: str):
            """Return async generator for WebSocket transcript stream."""
            from ..ws import transcript_stream
            return transcript_stream(client, bot_id)

    return TranscriptsResource()
