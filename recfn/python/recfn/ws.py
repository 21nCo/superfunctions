"""Async WebSocket transcript stream."""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Tuple

import websockets

from .client import RecFnHttpClient
from .types import Participant, Segment, _parse_participant, _parse_segment


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

    async def send_ping(ws: Any) -> None:
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
                try:
                    msg = json.loads(raw)
                    t = msg.get("type", "")
                    if t == "pong":
                        continue
                    data = msg.get("data")
                    if t == "segment":
                        yield ("segment", _parse_segment(data) if isinstance(data, dict) else data)
                    elif t == "participant_joined":
                        yield (
                            "participant_joined",
                            _parse_participant(data) if isinstance(data, dict) else data,
                        )
                    elif t == "participant_left":
                        pid = data.get("participantId", "") if isinstance(data, dict) else ""
                        yield ("participant_left", {"participant_id": pid})
                    elif t == "status":
                        bs = data.get("botStatus", "") if isinstance(data, dict) else ""
                        yield ("status", {"bot_status": bs})
                    elif t == "error":
                        code = data.get("code", "") if isinstance(data, dict) else ""
                        msg_text = data.get("message", "") if isinstance(data, dict) else ""
                        yield ("error", {"code": code, "message": msg_text})
                except (json.JSONDecodeError, KeyError):
                    pass
        finally:
            ping_task.cancel()
            try:
                await ping_task
            except asyncio.CancelledError:
                pass
