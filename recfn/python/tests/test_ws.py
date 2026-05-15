"""Tests for RecFn WebSocket transcript stream."""

import json
import subprocess
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path

import pytest

from recfn.client import RecFnHttpClient
from recfn.ws import STATUS_REQUIRED_KEYS, transcript_stream


@pytest.mark.asyncio
async def test_transcript_stream_yields_segments() -> None:
    client = RecFnHttpClient(base_url="https://api.example.com", api_key="sk-test")

    messages = [
        json.dumps({"type": "segment", "data": {"speakerId": "s1", "startTime": 0, "endTime": 1, "text": "Hi", "confidence": 0.9}}),
        json.dumps({"type": "pong"}),
        json.dumps({"type": "segment", "data": {"speakerId": "s2", "startTime": 1, "endTime": 2, "text": "Hello", "confidence": 0.95}}),
    ]

    mock_ws = MagicMock()
    mock_ws.__aiter__.return_value = iter(messages)
    mock_ws.send = AsyncMock()

    mock_connect = MagicMock()
    mock_connect.return_value.__aenter__ = AsyncMock(return_value=mock_ws)
    mock_connect.return_value.__aexit__ = AsyncMock(return_value=None)

    with patch("recfn.ws.websockets.connect", mock_connect):
        segments = []
        async for event_type, data in transcript_stream(client, "bot-123"):
            if event_type == "segment":
                segments.append(data)
            if len(segments) >= 2:
                break

        assert len(segments) == 2
        assert segments[0].text == "Hi"
        assert segments[0].speaker_id == "s1"
        assert segments[1].text == "Hello"
        assert segments[1].speaker_id == "s2"


@pytest.mark.asyncio
async def test_transcript_stream_yields_participant_events() -> None:
    client = RecFnHttpClient(base_url="https://api.example.com", api_key="sk-test")

    messages = [
        json.dumps({
            "type": "participant_joined",
            "data": {"id": "p1", "botId": "b1", "name": "Alice", "role": "host", "joinedAt": "2024-01-01T00:00:00Z", "consent": "granted"},
        }),
        json.dumps({"type": "participant_left", "data": {"participantId": "p1"}}),
    ]

    mock_ws = MagicMock()
    mock_ws.__aiter__.return_value = iter(messages)
    mock_ws.send = AsyncMock()

    mock_connect = MagicMock()
    mock_connect.return_value.__aenter__ = AsyncMock(return_value=mock_ws)
    mock_connect.return_value.__aexit__ = AsyncMock(return_value=None)

    with patch("recfn.ws.websockets.connect", mock_connect):
        events = []
        async for event_type, data in transcript_stream(client, "bot-123"):
            events.append((event_type, data))
            if len(events) >= 2:
                break

        assert len(events) == 2
        assert events[0][0] == "participant_joined"
        assert events[0][1].name == "Alice"
        assert events[0][1].role == "host"
        assert events[1][0] == "participant_left"
        assert events[1][1]["participant_id"] == "p1"


@pytest.mark.asyncio
async def test_get_ws_url() -> None:
    client = RecFnHttpClient(base_url="https://api.example.com", api_key="sk-test")
    url = client.get_ws_url("/ws/transcripts/bot-1")
    assert url.startswith("wss://")
    assert "api.example.com" in url
    assert "/ws/transcripts/bot-1" in url
    assert "token=sk-test" in url


@pytest.mark.asyncio
async def test_transcript_stream_uses_canonical_status_frames() -> None:
    client = RecFnHttpClient(base_url="https://api.example.com", api_key="sk-test")

    messages = [
        json.dumps({"type": "status", "data": {"status": "recording"}}),
        json.dumps({"type": "status", "data": {"botStatus": "recording"}}),
    ]

    mock_ws = MagicMock()
    mock_ws.__aiter__.return_value = iter(messages)
    mock_ws.send = AsyncMock()

    mock_connect = MagicMock()
    mock_connect.return_value.__aenter__ = AsyncMock(return_value=mock_ws)
    mock_connect.return_value.__aexit__ = AsyncMock(return_value=None)

    with patch("recfn.ws.websockets.connect", mock_connect):
        events = []
        async for event_type, data in transcript_stream(client, "bot-123"):
            events.append((event_type, data))
            if len(events) >= 1:
                break

        assert events == [("status", {"bot_status": "recording"})]


def test_ws_schema_matches_shared_core_contract() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import { TRANSCRIPT_STREAM_FRAME_SCHEMA } from '@recfn/core'; "
                "console.log(JSON.stringify(TRANSCRIPT_STREAM_FRAME_SCHEMA));"
            ),
        ],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )

    schema = json.loads(result.stdout)
    assert schema["status"]["requiredKeys"] == ["botStatus"]
    assert schema["participant_left"]["requiredKeys"] == ["participantId"]
    assert schema["error"]["requiredKeys"] == ["code", "message"]
    assert list(STATUS_REQUIRED_KEYS) == ["botStatus"]
