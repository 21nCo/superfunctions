"""Tests for RecFn HTTP client and resources."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from recfn import RecFn
from recfn.types import AggregateBotDetail, Bot, Segment, _parse_bot, _parse_segment


def test_parse_bot() -> None:
    d = {
        "id": "b1",
        "namespace": "ns1",
        "meetingUrl": "https://zoom.us/j/123",
        "platform": "zoom",
        "status": "joined",
        "config": {},
        "createdAt": "2024-01-01T00:00:00Z",
        "updatedAt": "2024-01-01T00:00:00Z",
    }
    b = _parse_bot(d)
    assert b.id == "b1"
    assert b.meeting_url == "https://zoom.us/j/123"
    assert b.platform == "zoom"
    assert b.status == "joined"


def test_parse_segment() -> None:
    d = {
        "speakerId": "s1",
        "startTime": 0.5,
        "endTime": 1.2,
        "text": "Hello",
        "confidence": 0.95,
    }
    s = _parse_segment(d)
    assert s.speaker_id == "s1"
    assert s.start_time == 0.5
    assert s.end_time == 1.2
    assert s.text == "Hello"
    assert s.confidence == 0.95


@pytest.mark.asyncio
async def test_client_request_success() -> None:
    mock_resp = MagicMock()
    mock_resp.is_success = True
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {
        "ok": True,
        "data": {
            "id": "b1",
            "namespace": "ns1",
            "meetingUrl": "https://zoom.us/j/123",
            "platform": "zoom",
            "status": "joined",
            "config": {},
            "participants": [],
            "recordings": [],
            "metadata": None,
            "chatMessages": [],
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z",
        },
    }
    mock_resp.reason_phrase = "OK"
    mock_resp.status_code = 200

    mock_instance = MagicMock()
    mock_instance.request = AsyncMock(return_value=mock_resp)

    with patch("recfn.client.httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

        client = RecFn(base_url="https://api.example.com", api_key="sk-test")
        res = await client.bots.get("b1")

        assert res.get("ok") is True
        assert res.get("data") is not None
        assert isinstance(res["data"], AggregateBotDetail)
        assert res["data"].id == "b1"
        assert res["data"].status == "joined"


@pytest.mark.asyncio
async def test_client_request_error() -> None:
    mock_resp = MagicMock()
    mock_resp.is_success = False
    mock_resp.status_code = 404
    mock_resp.reason_phrase = "Not Found"
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {
        "ok": False,
        "error": {"code": "NOT_FOUND", "message": "Bot not found", "details": {}},
    }

    mock_instance = MagicMock()
    mock_instance.request = AsyncMock(return_value=mock_resp)

    with patch("recfn.client.httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

        client = RecFn(base_url="https://api.example.com", api_key="sk-test")
        res = await client.bots.get("b1")

        assert res.get("ok") is False
        assert "error" in res
        assert res["error"]["code"] == "NOT_FOUND"
        assert res["error"]["message"] == "Bot not found"


@pytest.mark.asyncio
async def test_bots_create() -> None:
    mock_resp = MagicMock()
    mock_resp.is_success = True
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {
        "ok": True,
        "data": {
            "id": "b2",
            "namespace": "default",
            "meetingUrl": "https://meet.google.com/abc",
            "platform": "meet",
            "status": "creating",
            "config": {},
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z",
        },
    }

    mock_instance = MagicMock()
    mock_instance.request = AsyncMock(return_value=mock_resp)

    with patch("recfn.client.httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

        client = RecFn(base_url="https://api.example.com", api_key="sk-test")
        res = await client.bots.create("https://meet.google.com/abc", platform="meet")

        assert res.get("ok") is True
        assert res["data"].id == "b2"
        assert res["data"].platform == "meet"


@pytest.mark.asyncio
async def test_recordings_list() -> None:
    mock_resp = MagicMock()
    mock_resp.is_success = True
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {
        "ok": True,
        "data": {
            "recordings": [
                {
                    "id": "r1",
                    "botId": "b1",
                    "format": "mp4",
                    "duration": 120.5,
                    "storageRef": "s3://bucket/r1",
                    "size": 1024000,
                    "createdAt": "2024-01-01T00:00:00Z",
                },
            ],
        },
    }

    mock_instance = MagicMock()
    mock_instance.request = AsyncMock(return_value=mock_resp)

    with patch("recfn.client.httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

        client = RecFn(base_url="https://api.example.com", api_key="sk-test")
        res = await client.recordings.list("b1")

        assert res.get("ok") is True
        recs = res["data"]["recordings"]
        assert len(recs) == 1
        assert recs[0].id == "r1"
        assert recs[0].duration == 120.5


@pytest.mark.asyncio
async def test_bots_get_returns_aggregate_detail() -> None:
    mock_resp = MagicMock()
    mock_resp.is_success = True
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {
        "ok": True,
        "data": {
            "id": "b1",
            "namespace": "ns1",
            "meetingUrl": "https://zoom.us/j/123",
            "platform": "zoom",
            "status": "recording",
            "config": {},
            "participants": [
                {
                    "id": "p1",
                    "botId": "b1",
                    "name": "Alice",
                    "role": "host",
                    "joinedAt": "2024-01-01T00:00:00Z",
                    "consent": "granted",
                }
            ],
            "recordings": [
                {
                    "id": "r1",
                    "botId": "b1",
                    "format": "mp4",
                    "duration": 12,
                    "storageRef": "recordings/ns/r1.mp4",
                    "size": 12,
                    "createdAt": "2024-01-01T00:00:00Z",
                }
            ],
            "metadata": {
                "id": "m1",
                "botId": "b1",
                "title": "Daily Sync",
                "platform": "zoom",
                "chatMessages": [
                    {
                        "participantId": "p1",
                        "text": "hello",
                        "timestamp": "2024-01-01T00:00:00Z",
                    }
                ],
            },
            "chatMessages": [
                {
                    "participantId": "p1",
                    "text": "hello",
                    "timestamp": "2024-01-01T00:00:00Z",
                }
            ],
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-01T00:00:00Z",
        },
    }

    mock_instance = MagicMock()
    mock_instance.request = AsyncMock(return_value=mock_resp)

    with patch("recfn.client.httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

        client = RecFn(base_url="https://api.example.com", api_key="sk-test")
        res = await client.bots.get("b1")

        assert res.get("ok") is True
        detail = res["data"]
        assert isinstance(detail, AggregateBotDetail)
        assert detail.participants[0].name == "Alice"
        assert detail.recordings[0].id == "r1"
        assert detail.metadata is not None
        assert detail.metadata.title == "Daily Sync"
        assert detail.chat_messages[0].text == "hello"


@pytest.mark.asyncio
async def test_recordings_upload() -> None:
    mock_resp = MagicMock()
    mock_resp.is_success = True
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {
        "ok": True,
        "data": {
            "id": "r2",
            "botId": "b1",
            "format": "webm",
            "duration": 10,
            "storageRef": "recordings/ns/r2.webm",
            "size": 3,
            "createdAt": "2024-01-01T00:00:00Z",
        },
    }

    mock_instance = MagicMock()
    mock_instance.request = AsyncMock(return_value=mock_resp)

    with patch("recfn.client.httpx.AsyncClient") as mock_client_cls:
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

        client = RecFn(base_url="https://api.example.com", api_key="sk-test")
        res = await client.recordings.upload(
            b"abc",
            {"bot_id": "bot_123", "transcribe": True},
        )

        assert res.get("ok") is True
        assert res["data"].id == "r2"
        call = mock_instance.request.await_args
        assert "botId=bot_123&transcribe=true" in call.args[1]
        assert call.kwargs["files"]["file"][1] == b"abc"
