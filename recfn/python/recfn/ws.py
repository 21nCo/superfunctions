"""Async WebSocket transcript stream."""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncContextManager, AsyncIterator, NoReturn, Protocol, Tuple

from .client import RecFnHttpClient
from .types import _parse_participant, _parse_segment


class _TranscriptSocket(Protocol):
    def __aiter__(self) -> AsyncIterator[str | bytes]: ...

    async def send(self, message: str) -> None: ...


class _WebsocketsModule(Protocol):
    def connect(self, uri: str) -> AsyncContextManager[_TranscriptSocket]: ...


class _MissingWebsocketsModule:
    def connect(self, uri: str) -> NoReturn:
        raise ModuleNotFoundError(
            "websockets is required for transcript streaming. Install the recfn "
            "Python package with its runtime dependencies."
        )


websockets: _WebsocketsModule
try:
    import websockets as _websockets
except ModuleNotFoundError:  # pragma: no cover - missing dependency fallback
    websockets = _MissingWebsocketsModule()
else:
    websockets = _websockets

STATUS_REQUIRED_KEYS = ("botStatus",)


def _parse_transcript_frame(raw: str | bytes) -> Tuple[str, Any] | None:
    try:
        msg = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None

    if not isinstance(msg, dict):
        return None

    frame_type = msg.get("type", "")
    data = msg.get("data")

    if frame_type == "pong":
        return None
    if frame_type == "segment" and isinstance(data, dict):
        return ("segment", _parse_segment(data))
    if frame_type == "participant_joined" and isinstance(data, dict):
        return ("participant_joined", _parse_participant(data))
    if frame_type == "participant_left" and isinstance(data, dict):
        participant_id = data.get("participantId")
        if isinstance(participant_id, str):
            return ("participant_left", {"participant_id": participant_id})
        return None
    if frame_type == "status" and isinstance(data, dict):
        # Only accept the canonical status payload shape.
        bot_status = data.get(STATUS_REQUIRED_KEYS[0])
        if isinstance(bot_status, str):
            return ("status", {"bot_status": bot_status})
        return None
    if frame_type == "error" and isinstance(data, dict):
        code = data.get("code")
        message = data.get("message")
        if isinstance(code, str) and isinstance(message, str):
            return ("error", {"code": code, "message": message})
        return None

    return None


async def transcript_stream(
    client: RecFnHttpClient,
    bot_id: str,
) -> AsyncIterator[Tuple[str, Any]]:
    """Async generator for transcript WebSocket stream.

    Yields (event_type, data) tuples:
      - ("segment", Segment)
      - ("participant_joined", Participant)
      - ("participant_left", {"participant_id": str})
      - ("status", {"bot_status": str})
      - ("error", {"code": str, "message": str})

    Handles ping/pong. Does not auto-reconnect.
    """
    url = client.get_ws_url(f"/ws/transcripts/{bot_id}")
    ping_interval = 30.0

    async def send_ping(ws: _TranscriptSocket) -> None:
        while True:
            await asyncio.sleep(ping_interval)
            try:
                await ws.send(json.dumps({"type": "ping"}))
            except Exception:
                break

    async with websockets.connect(url) as ws:
        ping_task = asyncio.create_task(send_ping(ws))
        try:
            async for raw in ws:
                parsed = _parse_transcript_frame(raw)
                if parsed is not None:
                    yield parsed
        finally:
            ping_task.cancel()
            try:
                await ping_task
            except asyncio.CancelledError:
                pass
