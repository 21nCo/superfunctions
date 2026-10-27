import json
import time
from typing import Any

import pytest

from logfn import (
    MAX_EVENT_SIZE,
    MAX_METADATA_CHARS,
    MAX_REDACTION_DEPTH,
    MAX_TAGS,
    SinkHttp,
    enrich_context,
    is_sensitive_key,
    parse_w3c_trace_context,
    redact,
    redact_event,
    sample,
    sanitize_event,
    sanitize_value,
    validate_and_serialize,
    with_request_ids,
)
from logfn.types import LogEvent


def make_event(**overrides: Any) -> LogEvent:
    event: dict[str, Any] = {"ts": "2026-01-01T00:00:00.000Z", "level": "info", "msg": "m", "name": "t", "version": "0"}
    event.update(overrides)
    return event  # type: ignore[return-value]


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("password", True),
        ("DB_PASSWORD", True),
        ("x-api-key", True),
        ("refreshToken", True),
        ("Set-Cookie", True),
        ("sid", True),
        ("maxTokens", False),
        ("token_count", False),
        ("author", False),
        ("keyboard", False),
    ],
)
def test_is_sensitive_key(key: str, expected: bool) -> None:
    assert is_sensitive_key(key) is expected


def test_custom_patterns_replace_only_the_default_extras() -> None:
    result = redact(patterns=[r"secret-\d+"])(make_event(msg="ada@example.com secret-123 token=abc"))
    assert result is not None
    assert result["msg"] == "ada@example.com [redacted] token=[redacted]"


def test_replacement_and_input_not_modified() -> None:
    event = make_event(msg="token=abc", ctx={"nested": {"password": "pw"}}, tags=["token=x"])
    snapshot = json.loads(json.dumps(event))
    assert redact_event(event, replacement="***")["ctx"] == {"nested": {"password": "***"}}
    assert event == snapshot


def test_cause_cycles_and_depth() -> None:
    first = ValueError("first token=a")
    second = ValueError("second")
    second.__cause__ = first
    first.__cause__ = second
    ctx = redact_event(make_event(ctx={"error": first}))["ctx"]
    assert ctx["error"]["message"] == "first token=[redacted]"
    assert ctx["error"]["cause"]["cause"] == "[circular]"

    deep: dict[str, Any] = {"leaf": "password=x"}
    for _ in range(MAX_REDACTION_DEPTH + 5):
        deep = {"next": deep}
    out = json.dumps(redact_event(make_event(ctx=deep))["ctx"])
    assert "[max-depth]" in out and "password=x" not in out


def test_empty_replacement_is_rejected() -> None:
    # An empty marker would make ``password= next`` read as a password of ``next``.
    with pytest.raises(ValueError, match="non-empty"):
        redact(replacement="")
    with pytest.raises(ValueError, match="non-empty"):
        redact_event(make_event(msg="password=x"), replacement="")
    with pytest.raises(ValueError, match="non-empty"):
        SinkHttp("https://collector.test/ingest", redact_replacement="")


def test_linear_time_on_adversarial_input() -> None:
    inputs = [
        "a" * 200_000,
        "a." * 100_000,
        "a=" * 100_000,
        "https://" * 25_000,
        "x@" * 100_000,
        "bearer " * 30_000,
        "\\" * 200_000,
        "\\" * 200_000 + '"',
        'password="' + '\\"' * 100_000,
        "?token=" + "\\" * 200_000 + "'",
        "&token=" * 30_000,
        '\\"token\\":' * 20_000,
        "password=" + "[" * 200_000,
        "token=[" + '\\"' * 100_000,
        "secret={" + '"a\\' * 60_000,
        "token=[redacted]" * 15_000,
        "%3Fa" * 50_000,
        "%3Fapi_key%3D" + "%2F" * 60_000,
        '"a ' * 60_000,
        '"' + "a " * 100_000,
        "\\" * 100_000 + '"a b',
        "x" + "\\n" * 100_000,
        "a" + " \n" * 100_000,
        "n:" + "\\n" * 100_000,
        "https://" + "a@" * 100_000,
        ("a://" + "b:" * 10 + " ") * 10_000,
        'password="x"' + "a" * 200_000,
    ]
    started = time.monotonic()
    for msg in inputs:
        redact_event(make_event(msg=msg))
    # Linear on these ~200 KB inputs takes seconds at most; quadratic would take hours.
    assert time.monotonic() - started < 30


def test_enrich_context_event_wins_and_input_is_not_mutated() -> None:
    counter = iter(range(1, 10))
    stage = enrich_context({"app": "a", "env": "dev"}, lambda: {"seq": next(counter), "env": "dynamic"})
    event = make_event(ctx={"app": "override"})
    result = stage(event)
    assert result is not None
    assert result["ctx"] == {"app": "override", "env": "dynamic", "seq": 1}
    assert event["ctx"] == {"app": "override"}


def test_sample_uses_rates_and_random_source() -> None:
    values = iter([0.05, 0.5])
    stage = sample({"info": 0.1}, random_fn=lambda: next(values))
    assert stage(make_event()) is not None
    assert stage(make_event()) is None
    assert stage(make_event(level="error")) is not None
    assert stage(make_event(level="trace")) is None
    assert sample({"info": float("nan")})(make_event()) is None


def test_sample_keeps_about_the_rate() -> None:
    stage = sample({"info": 0.25})
    kept = sum(1 for _ in range(20_000) if stage(make_event()) is not None)
    assert 0.22 < kept / 20_000 < 0.28


def test_request_ids() -> None:
    result = with_request_ids()(make_event())
    assert result is not None
    assert len(result["traceId"]) == 32 and len(result["spanId"]) == 16 and len(result["requestId"]) == 32
    kept = with_request_ids()(make_event(requestId="r1", traceId="t1"))
    assert kept is not None and kept["requestId"] == "r1" and kept["traceId"] == "t1"
    assert parse_w3c_trace_context("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01") == {
        "traceId": "0af7651916cd43dd8448eb211c80319c",
        "spanId": "b7ad6b7169203331",
    }
    assert parse_w3c_trace_context("00-00000000000000000000000000000000-b7ad6b7169203331-01") is None
    assert parse_w3c_trace_context("01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01") is None
    for flags in ("", "1", "001", "zz", "0A"):
        assert parse_w3c_trace_context(f"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-{flags}") is None


def test_sanitize_value() -> None:
    class Opaque:
        pass

    shared = {"v": 1}
    root: dict[str, Any] = {"a": shared, "b": shared, "obj": Opaque(), "nan": float("nan"), "inf": float("-inf"), "t": (1, 2)}
    root["self"] = root
    assert sanitize_value(root) == {
        "a": {"v": 1},
        "b": {"v": 1},
        "obj": "[unserializable]",
        "nan": "NaN",
        "inf": "-Infinity",
        "t": [1, 2],
        "self": "[circular]",
    }


def test_validate_and_serialize_bounds_size() -> None:
    def size(event: LogEvent) -> int:
        return len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode())

    tags_event, truncated = validate_and_serialize(make_event(tags=[f"t{i}" for i in range(MAX_TAGS + 5)]))
    assert len(tags_event["tags"]) == MAX_TAGS and not truncated

    big, truncated = validate_and_serialize(make_event(ctx={"blob": "é" * MAX_EVENT_SIZE}))
    assert truncated and big["ctx"]["_truncated"] is True and size(big) <= MAX_EVENT_SIZE

    huge, truncated = validate_and_serialize(make_event(msg="€" * MAX_EVENT_SIZE))
    assert truncated and huge["msg"].endswith("...[truncated]") and size(huge) <= MAX_EVENT_SIZE


@pytest.mark.parametrize(
    "overrides",
    [
        {"name": "x" * 70_000},
        {"requestId": "€" * 30_000},
        {"extra": "x" * 70_000},
        {"tags": ["t" * 4_000] * MAX_TAGS},
        {"name": "\u0001" * 20_000, "msg": "\u0002" * 20_000},
    ],
    ids=["name", "requestId", "non-schema-field", "tags", "control-characters"],
)
def test_validate_and_serialize_bounds_every_field(overrides: dict[str, Any]) -> None:
    out, truncated = validate_and_serialize(make_event(**{"msg": "keep this message", **overrides}))
    assert truncated
    assert len(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode()) <= MAX_EVENT_SIZE
    assert out["level"] == make_event()["level"] and out["ts"] == make_event()["ts"]


def test_validate_and_serialize_keeps_message_and_small_metadata() -> None:
    out, _ = validate_and_serialize(make_event(msg="keep", requestId="req-1", tags=["a"], ctx={"blob": "x" * MAX_EVENT_SIZE}))
    assert (out["msg"], out["requestId"], out["tags"]) == ("keep", "req-1", ["a"])

    capped, _ = validate_and_serialize(make_event(name="x" * 70_000, msg="keep"))
    assert len(capped["name"]) == MAX_METADATA_CHARS and capped["name"].endswith("...[truncated]")
    assert capped["msg"] == "keep"


def test_sanitize_event_makes_every_field_json_safe() -> None:
    class Leaky:
        def __str__(self) -> str:
            return "password=STR_SECRET"

    out = sanitize_event(make_event(tags=[1, {"a": 1}], userId=Leaky(), extra=b"bytes"))  # type: ignore[arg-type]
    assert out["tags"] == ["1", '{"a":1}']
    assert out["userId"] == "[unserializable]" and out["extra"] == "[unserializable]"  # type: ignore[typeddict-item]
    json.dumps(out)

