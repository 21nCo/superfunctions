import asyncio
import http.client
import socket
import urllib.request
from typing import Any

import pytest

import logfn


def test_default_configurations_perform_no_network_io(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    attempts: list[str] = []

    def forbid(name: str) -> Any:
        def spy(*args: Any, **kwargs: Any) -> Any:
            attempts.append(name)
            raise AssertionError(f"network I/O attempted via {name}")

        return spy

    monkeypatch.setattr(socket.socket, "connect", forbid("socket.connect"))
    monkeypatch.setattr(socket.socket, "connect_ex", forbid("socket.connect_ex"))
    monkeypatch.setattr(socket, "create_connection", forbid("socket.create_connection"))
    monkeypatch.setattr(socket, "getaddrinfo", forbid("socket.getaddrinfo"))
    monkeypatch.setattr(urllib.request, "urlopen", forbid("urllib.request.urlopen"))
    monkeypatch.setattr(http.client.HTTPConnection, "request", forbid("http.client.HTTPConnection.request"))

    loggers = [
        logfn.create_logger("default"),
        logfn.create_logger(
            "full-pipeline",
            level="trace",
            pipeline=[logfn.with_request_ids(), logfn.enrich_context({"app": "a"}), logfn.redact(), logfn.sample({"info": 1})],
        ),
        logfn.dev_logger("dev"),
        logfn.server_logger("server"),
    ]

    async def scenario() -> None:
        for logger in loggers:
            for level in ("trace", "debug", "info", "warn", "error", "fatal"):
                getattr(logger, level)("message https://u:p@example.com", ValueError("boom"))
            await logger.flush()
        sink = logfn.SinkHttp("https://collector.test/ingest", flush_interval_ms=1)
        await sink.flush()
        await asyncio.sleep(0.02)

    asyncio.run(scenario())
    assert attempts == []
    assert "message" in capsys.readouterr().out
