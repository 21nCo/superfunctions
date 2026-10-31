import asyncio
import json
import re
from collections.abc import Callable
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


def test_no_credential_in_json_text_reaches_the_sink_body_whatever_its_formatting() -> None:
    # Credential keys at several depths, holding strings, numbers and objects.
    def document(n: int) -> dict[str, Any]:
        return {
            "token": f"S{n}_TOP",
            "service": {
                "name": "billing",
                "auth": {"user": "svc", "password": f"S{n}_NESTED"},
                "hosts": [{"host": "a", "apiKey": f"S{n}_ARRAY"}],
                "retries": {"client_secret": f"S{n}_DEEP", "max": 3},
            },
            "credentials": {"id": f"S{n}_OBJECT"},
        }

    def crlf(text: str) -> str:
        return text.replace("\n", "\r\n")

    def newline_before_value(text: str) -> str:
        return text.replace('": ', '":\n    ')

    formats: list[Callable[[Any], str]] = [
        lambda value: json.dumps(value, separators=(",", ":")),
        lambda value: json.dumps(value),
        lambda value: json.dumps(value, indent=2),
        lambda value: json.dumps(value, indent=4),
        lambda value: json.dumps(value, indent="\t"),
        lambda value: newline_before_value(json.dumps(value, indent=2)),
        lambda value: crlf(json.dumps(value, indent=2)),
        lambda value: crlf(newline_before_value(json.dumps(value, indent=2))),
    ]
    escaped = [lambda value, format=format: json.dumps(format(value)) for format in formats]
    bodies: list[bytes] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    sink = logfn.SinkHttp("https://collector.test/ingest", transport=transport, max_queue=1000, batch_size=1000)
    base = {"ts": "2026-01-14T12:00:00.000Z", "level": "info", "name": "t", "version": "0"}
    for n, format in enumerate(formats + escaped):
        sink([{**base, "msg": format(document(n))}])  # type: ignore[list-item]
        sink([{**base, "msg": "m", "ctx": {"text": format(document(n + 100))}}])  # type: ignore[list-item]
    asyncio.run(sink.flush())
    body = b"\n".join(bodies).decode()
    assert sum(len(json.loads(b)["events"]) for b in bodies) == 2 * len(formats + escaped)
    assert re.findall(r"S\d+_[A-Z]+", body) == []
    assert "billing" in body


def test_no_secret_fragment_reaches_the_sink_body_when_the_message_is_cut_at_the_size_limit() -> None:
    # No redaction stage: SinkHttp's own redaction is the only guard, so it
    # must see the whole message, not one cut through a secret's delimiter.
    secrets = [
        "https://u:QJURL1@host.test/path",
        "contact qjmail.user@example.com today",
        "Authorization: Bearer QJBEARER\n",
        '{"password":"QJJSON"}',
        "https://h.test/cb?token=QJQUERY&next=1",
    ]
    bodies: list[bytes] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    sink = logfn.SinkHttp("https://collector.test/ingest", transport=transport, max_queue=5000, batch_size=5000)
    logger = logfn.create_logger("t", sinks=[sink], level="trace")
    child = logger.child(name="child")

    def sent_events() -> list[dict[str, Any]]:
        return [event for body in bodies for event in json.loads(body)["events"]]

    # Characters of an oversized message the sink keeps (everything is ASCII).
    logger.info("x" * 100_000)
    asyncio.run(logger.flush())
    kept = len(sent_events()[0]["msg"]) - len("...[truncated]")
    bodies.clear()
    logged = 0
    for secret in secrets:
        for target in (logger, child):
            # Cuts from just before the secret to just after it.
            for start in range(kept - len(secret) - 4, kept + 3):
                target.info(f"{'x' * (start - 1)} {secret} {'z' * 2000}")
                logged += 1
    asyncio.run(logger.flush())
    events = sent_events()
    assert len(events) == logged
    assert all(event["msg"].endswith("...[truncated]") for event in events)
    body = b"\n".join(bodies).decode()
    assert re.findall(r"(?i)qj\w*", body) == []
    assert "[redacted]" in body


def test_server_logger_with_url_redacts_before_http(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    bodies: list[bytes] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    monkeypatch.setattr(logfn.sinks, "stdlib_transport", transport)
    logger = logfn.server_logger("server", url="https://collector.test/ingest")
    logger.error("db down postgres://svc:pw-123@db/app", password="hunter2", token="t-1")
    asyncio.run(logger.flush())
    assert len(bodies) == 1
    for secret in (b"pw-123", b"hunter2", b"t-1"):
        assert secret not in bodies[0]
    assert "hunter2" not in capsys.readouterr().out


def test_server_logger_redacts_a_credential_bearing_exception_name(capsys: pytest.CaptureFixture[str]) -> None:
    remote = type("RemoteError token=NAME_SECRET", (Exception,), {})
    upstream = type("Upstream https://u:CAUSE_SECRET@h.test/x", (Exception,), {})
    try:
        try:
            raise upstream("refused")
        except Exception as cause:
            raise remote("failed") from cause
    except Exception as error:
        logfn.server_logger("svc").error("failed", error)
    output = capsys.readouterr().out
    assert "RemoteError token=[redacted]" in output
    assert "NAME_SECRET" not in output and "CAUSE_SECRET" not in output
