import asyncio
import json
from typing import Any

import pytest
from conformance_harness import TYPESCRIPT_VECTORS_PATH, VECTORS_PATH, load_vectors, run_vector

import logfn

VECTORS = load_vectors()


def test_vectors_match_the_typescript_copy_and_marker() -> None:
    assert VECTORS["marker"] == logfn.REDACTED
    assert len(VECTORS["vectors"]) >= 12
    if not TYPESCRIPT_VECTORS_PATH.exists():
        pytest.skip("TypeScript package is not next to this checkout")
    assert VECTORS_PATH.read_bytes() == TYPESCRIPT_VECTORS_PATH.read_bytes()


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda vector: vector["id"])
def test_vector(vector: dict[str, Any]) -> None:
    assert run_vector(logfn, vector) == ["stage", "logger", "SinkHttp", "SinkHttp direct"]


def test_sink_redacts_context_added_after_the_redaction_stage() -> None:
    bodies: list[bytes] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    sink = logfn.SinkHttp("https://collector.test/ingest", transport=transport)
    logger = logfn.create_logger(
        "late",
        pipeline=[logfn.redact(), logfn.enrich_context({"apiKey": "late-key", "dsn": "https://u:late-pw@db.test"})],
        sinks=[sink],
    )
    logger.info("late")
    asyncio.run(sink.flush())
    assert b"late-key" not in bodies[0] and b"late-pw" not in bodies[0]
    assert json.loads(bodies[0])["events"][0]["ctx"] == {"apiKey": "[redacted]", "dsn": "https://[redacted]@db.test"}


def test_server_logger_with_url_redacts_before_http(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    bodies: list[bytes] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    monkeypatch.setattr(logfn.sinks, "urllib_transport", transport)
    logger = logfn.server_logger("server", url="https://collector.test/ingest")
    logger.error("db down postgres://svc:pw-123@db/app", password="hunter2", token="t-1")
    asyncio.run(logger.flush())
    assert len(bodies) == 1
    for secret in (b"pw-123", b"hunter2", b"t-1"):
        assert secret not in bodies[0]
    assert "hunter2" not in capsys.readouterr().out
