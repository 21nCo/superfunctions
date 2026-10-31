import asyncio
import decimal
import json
import linecache
import random
import re
import time
import tracemalloc
from pathlib import Path
from typing import Any

import pytest

from logfn import (
    MAX_EVENT_SIZE,
    MAX_METADATA_CHARS,
    MAX_REDACTION_DEPTH,
    MAX_TAGS,
    REDACTED,
    SinkHttp,
    create_logger,
    enrich_context,
    is_sensitive_key,
    is_valid_log_event,
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
from logfn.validation import MAX_TRAVERSAL


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


def test_sanitize_value_keeps_keys_that_become_the_same_text() -> None:
    assert sanitize_value({1: "numeric", "1": "text", "1#2": "taken"}) == {"1": "numeric", "1#2": "text", "1#2#2": "taken"}
    assert sanitize_value({"1#2": "taken", 1: "numeric", "1": "text"}) == {"1#2": "taken", "1": "numeric", "1#3": "text"}


def test_sanitize_event_makes_every_field_json_safe() -> None:
    class Leaky:
        def __str__(self) -> str:
            return "password=STR_SECRET"

    tags = [1, 2.0, 0.5, True, float("nan"), {"api/key": "TAG_SECRET"}, ["x"]]
    out = sanitize_event(make_event(tags=tags, userId=Leaky(), extra=b"bytes"))  # type: ignore[arg-type]
    # Numbers and booleans as JavaScript writes them; an object or list tag has no text a sink could redact by key.
    assert out["tags"] == ["1", "2", "0.5", "true", "NaN", "[unserializable]", "[unserializable]"]
    assert out["userId"] == "[unserializable]" and out["extra"] == "[unserializable]"  # type: ignore[typeddict-item]
    json.dumps(out)


# Float tags and the text String(number) gives them in JavaScript.
JS_NUMBER_TAGS = [
    (1e-6, "0.000001"),
    (1e-7, "1e-7"),
    (2.5e-5, "0.000025"),
    (-2.5e-5, "-0.000025"),
    (1.5e21, "1.5e+21"),
    (1e21, "1e+21"),
    (123456789012345680000.0, "123456789012345680000"),
    (-0.0, "0"),
    (0.1, "0.1"),
    (5e-324, "5e-324"),
    (1.2345, "1.2345"),
    (123456789.0, "123456789"),
    (0.30000000000000004, "0.30000000000000004"),
]


def test_float_tags_are_written_as_javascript_writes_numbers() -> None:
    out = sanitize_event(make_event(tags=[value for value, _ in JS_NUMBER_TAGS]))  # type: ignore[misc]
    assert out["tags"] == [text for _, text in JS_NUMBER_TAGS]


def test_float_tags_do_not_depend_on_or_change_the_decimal_context() -> None:
    trapping = decimal.Context(prec=2, Emax=5, Emin=-5, rounding=decimal.ROUND_DOWN, traps=[decimal.Inexact, decimal.Rounded])
    with decimal.localcontext(trapping) as context:
        out = sanitize_event(make_event(tags=[value for value, _ in JS_NUMBER_TAGS]))  # type: ignore[misc]
        assert (context.prec, context.flags[decimal.Inexact], context.flags[decimal.Rounded]) == (2, False, False)
    assert out["tags"] == [text for _, text in JS_NUMBER_TAGS]



# -- idempotency and markers (mirrors the TypeScript pipeline tests) ------------

_EMAIL = re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])")


def test_a_marker_is_never_read_by_a_later_rule_so_a_credential_url_keeps_its_host() -> None:
    text = "see https://user:pw@host.example/path or ada@example.com"
    for replacement in ("MASK", "x", REDACTED):
        expected = f"see https://{replacement}@host.example/path or {replacement}"
        output = redact_event(make_event(msg=text, ctx={"url": text, text: 1}), replacement=replacement)
        assert (output["msg"], output["ctx"]) == (expected, {"url": expected, expected: 1})
        assert redact_event(output, replacement=replacement) == output


@pytest.mark.parametrize(
    ("msg", "expected"),
    [
        ("password=https://u:p@h/x next", "password=MASK next"),
        ("Cookie: s=1; next=https://u:p@h/x; other=secret\nkeep", "Cookie: MASK\nkeep"),
        ("?token=a&next=https://u:p@h.example/x ada@example.com", "?token=MASK&next=https://MASK@h.example/x MASK"),
        ("Bearer abc%ada@example.com tail", "Bearer MASK tail"),
        ("tok_1tok_2 tok_3", "MASK MASK"),
    ],
)
def test_a_value_runs_past_a_marker_and_touching_markers_join(msg: str, expected: str) -> None:
    options: dict[str, Any] = {"replacement": "MASK", "patterns": [_EMAIL, re.compile(r"tok_\d")]}
    output = redact_event(make_event(msg=msg), **options)
    assert output["msg"] == expected
    assert redact_event(output, **options)["msg"] == expected


def test_redacting_twice_changes_nothing_for_seeded_concatenations_of_rule_inputs() -> None:
    draw = random.Random(0x5EED)
    parts = [
        "https://user:pw@host.example/path", "ftp://bob:x@h.io", "ada@example.com", "user@", "password=hunter2",
        'password="v"', '"secret":"v"', "token: 'a'", "Bearer abcDEF123", "?token=s3cr3t&x=1", "%3Ftoken%3Dabc",
        "Authorization: Basic Zm9v", "Cookie: sid=1; b=2", "\n", REDACTED, "MASK", "x", "a", "@", ":", "=", "/", ",",
        "{", "}", "tok_1",
    ]  # fmt: skip
    for separator in ("", " "):
        for replacement in (REDACTED, "MASK", "x", "***"):
            options: dict[str, Any] = {"replacement": replacement, "patterns": [re.compile(r"tok_\d"), _EMAIL]}
            for _ in range(500):
                msg = separator.join(draw.choice(parts) for _ in range(1 + draw.randrange(6)))
                once = redact_event(make_event(msg=msg, ctx={msg: msg}), **options)
                assert (msg, redact_event(once, **options)) == (msg, once)


def test_a_value_is_replaced_when_the_key_it_is_written_under_is_sensitive() -> None:
    # "%3Ftoken%3Dabc" is not a sensitive name, but its redacted text "%3Ftoken%3D***" reads as "token".
    output = redact_event({**make_event(ctx={"%3Ftoken%3Dabc": "v"}), "%3Ftoken%3Dabc": "v"}, replacement="***")  # type: ignore[typeddict-unknown-key]
    assert output["ctx"] == {"%3Ftoken%3D***": "***"} and output["%3Ftoken%3D***"] == "***"  # type: ignore[typeddict-item]
    assert redact_event(output, replacement="***") == output


def test_a_replacement_that_reads_as_a_credential_name_is_rejected() -> None:
    for replacement in ("SECRET", "TOKEN", "password", "Authorization", "api-key", "[auth]"):
        with pytest.raises(ValueError, match="sensitive key name"):
            redact(replacement=replacement)
        with pytest.raises(ValueError, match="sensitive key name"):
            SinkHttp("https://collector.test/ingest", redact_replacement=replacement)
    with pytest.raises(ValueError, match="sensitive key name"):
        redact(replacement="MASK", keys=["mask"])
    for replacement in ("MASK", "x", "***", REDACTED):
        output = redact_event(make_event(msg="alice@example.com: upload completed"), replacement=replacement)
        assert output["msg"] == f"{replacement}: upload completed"


@pytest.mark.parametrize(
    ("msg", "replacement", "pattern", "expected"),
    [
        ("a b", "<a a>", "a", "<a a> b"),  # a replacement the rules would redact is not redacted over and over
        ("abbbbb", "a", "ab", "a"),  # text the rules keep changing fails closed to the replacement
        ("a" + "b" * 50, "a", "ab", "a"),
        ("xa", "xx", "x(?=a)", "xx"),
    ],
)
def test_redaction_ends_and_text_that_never_settles_fails_closed(
    msg: str, replacement: str, pattern: str, expected: str
) -> None:
    options: dict[str, Any] = {"replacement": replacement, "patterns": [re.compile(pattern)]}
    assert redact_event(make_event(msg=msg), **options)["msg"] == expected
    if expected == replacement:
        assert redact_event(make_event(msg=expected), **options)["msg"] == expected


def test_a_credential_glued_to_a_quoted_or_bracketed_value_is_redacted() -> None:
    credentials = [
        "Authorization: Basic Zm9v", "Authorization:Basic Zm9v", "Authorization: Bearer abc123", "token=abc123",
        "token =abc123", 'token="Zm9v abc123"', "Bearer abc123",
    ]  # fmt: skip
    for value in ('"v"', "'v'", r"\"v\"", "[a]", "{a: 1}"):
        for separator in ("", "x", " "):
            for credential in credentials:
                if separator == "x" and credential.startswith("Bearer"):
                    continue
                msg = f'"secret": {value}{separator}{credential} tail'
                output = redact_event(make_event(msg=msg))["msg"]
                assert not re.search("Zm9v|abc123", output), (msg, output)
                assert redact_event(make_event(msg=output))["msg"] == output
    assert redact_event(make_event(msg='"secret":"v"xAuthorization: Basic Zm9v'))["msg"] == '"secret":"[redacted]"'
    assert redact_event(make_event(msg="password=vxtoken: abc123 tail"))["msg"] == "password=[redacted] tail"


def test_error_fields_obey_the_key_rules_and_the_allowlist_like_record_keys() -> None:
    def failure() -> BaseException:
        try:
            try:
                raise ValueError("cause PRIVATE_CAUSE")
            except ValueError as cause:
                raise RuntimeError("message PRIVATE_MESSAGE") from cause
        except RuntimeError as error:
            return error

    keys = ["message", "stack"]
    ctx = redact_event(make_event(ctx={"err": failure()}), keys=keys)["ctx"]
    assert ctx == {
        "err": {
            "name": "RuntimeError",
            "message": REDACTED,
            "stack": REDACTED,
            "cause": {"name": "ValueError", "message": REDACTED, "stack": REDACTED},
        }
    }
    kept = redact_event(make_event(ctx={"err": failure()}), keys=keys, allowlist=["err.message", "err.cause.stack"])
    err = kept["ctx"]["err"]
    assert err["message"] == "message PRIVATE_MESSAGE" and "PRIVATE_CAUSE" in err["cause"]["stack"]
    assert (err["stack"], err["cause"]["message"]) == (REDACTED, REDACTED)


def test_an_allowlisted_msg_and_field_names_are_kept_and_schema_fields_keep_their_names() -> None:
    assert redact_event(make_event(msg="token=abc"), allowlist=["msg"])["msg"] == "token=abc"
    # "ada@example.com" redacts to the marker, which an allowlisted "[redacted]" field already holds.
    both = redact_event({**make_event(), "[redacted]": "kept", "ada@example.com": "v"}, allowlist=["[redacted]"])  # type: ignore[typeddict-unknown-key]
    assert both["[redacted]"] == "kept" and both["[redacted]#2"] == "v"  # type: ignore[typeddict-item]
    # An extra field whose name redacts to a schema name is kept beside it, in any key order.
    for event in (
        {**make_event(), "userId": "u-1", "user%49d": "x"},
        {"user%49d": "x", **make_event(), "userId": "u-1"},
    ):
        output = redact_event(event, replacement="userId", patterns=[re.compile(r"user%49d")])  # type: ignore[arg-type]
        assert output["userId"] == "u-1" and output["userId#2"] == "x"  # type: ignore[typeddict-item]


def test_is_valid_log_event_checks_the_schema() -> None:
    assert is_valid_log_event(make_event(msg="", ctx={}, tags=["a"], traceId="t"))
    for overrides in (
        {"level": "verbose"},
        {"level": ["info"]},
        {"msg": 1},
        {"name": ""},
        {"traceId": 1},
        {"ctx": "text"},
        {"tags": "a"},
        {"tags": ["a", 1]},
    ):
        assert not is_valid_log_event(make_event(**overrides)), overrides
    assert not is_valid_log_event(["ts"])


# -- traversal budget ----------------------------------------------------------


def _shared(depth: int) -> dict[str, Any]:
    # n = {a: n1, b: n1}: depth objects, 2^depth paths.
    node: dict[str, Any] = {"leaf": "token=DAG_SECRET"}
    for _ in range(depth):
        node = {"a": node, "b": node}
    return node


def test_a_shared_graph_is_walked_once_per_budget_through_every_path() -> None:
    node = _shared(30)
    captured: list[LogEvent] = []
    bodies: list[bytes] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    sink = SinkHttp("https://collector.test/ingest", transport=transport)
    runs = [
        lambda: sanitize_value({"node": node}),
        lambda: sanitize_event(make_event(ctx={"node": node})),
        lambda: redact_event(make_event(ctx={"node": node})),
        lambda: (create_logger("dag", pipeline=[redact()], sinks=[captured.extend]).info("m", {"node": node}), captured[0])[1],
        lambda: (sink([make_event(ctx={"node": node})]), asyncio.run(sink.flush()), bodies[0].decode())[2],
    ]
    for index, run in enumerate(runs):
        started = time.monotonic()
        output = json.dumps(run())
        assert time.monotonic() - started < 10
        assert len(output) < 2 * MAX_TRAVERSAL
        # Sanitization alone does not redact; every other path does.
        assert index < 2 or "DAG_SECRET" not in output
    assert len(bodies[0]) <= MAX_EVENT_SIZE + 20


def test_wide_lists_wide_dicts_and_long_strings_stop_at_the_budget() -> None:
    wide = {f"k{index}": index for index in range(200_000)}
    for value in (list(range(300_000)), wide, ["x" * MAX_TRAVERSAL]):
        ctx = redact_event(make_event(ctx={"value": value}))["ctx"]
        assert len(json.dumps(ctx)) < 8 * MAX_TRAVERSAL
        # A list ends with MAX_SIZE; a dict ends at the first key past the budget.
        if isinstance(ctx["value"], list):
            assert ctx["value"][-1] == "[max-size]"
        else:
            assert len(ctx["value"]) < MAX_TRAVERSAL // 4


def test_values_past_the_budget_are_never_written_and_values_within_it_are_unchanged() -> None:
    # ctx costs 1, the key "fill" 4, fill its length plus 1, "late" 4, its value 18.
    fill = "f" * (MAX_TRAVERSAL - 20)
    ctx = redact_event(make_event(ctx={"fill": fill, "late": "token=LATE_SECRET", "nested": {"password": "LATE_PW"}}))
    assert ctx["ctx"] == {"fill": fill, "late": "[max-size]"}
    within = {"list": [1, "token=x", {"password": "p"}], "text": "y" * MAX_EVENT_SIZE}
    assert redact_event(make_event(ctx=within))["ctx"] == {
        "list": [1, "token=[redacted]", {"password": REDACTED}],
        "text": within["text"],
    }


def test_ctx_and_each_schema_field_have_their_own_budget() -> None:
    # Extra fields spend the shared budget first; the schema fields after them keep their values.
    extra = {f"x{index}": "v" * 1000 for index in range(400)}
    event = {"extra": "e" * MAX_TRAVERSAL, **extra, **make_event(ctx={"a": "b"}), "traceId": "t-1", "userId": "u-1"}
    output = sanitize_event(event)  # type: ignore[arg-type]
    assert (output["ctx"], output["traceId"], output["userId"], output["level"]) == ({"a": "b"}, "t-1", "u-1", "info")
    assert is_valid_log_event(output)
    assert len(output) < 20


def test_long_keys_are_classified_alike_but_never_kept_in_the_key_caches() -> None:
    import gc
    import tracemalloc

    # Plain, sensitive and percent-encoded names past the cached length are
    # classified exactly as their short forms, also inside logged text.
    for short, sensitive in {"a_x": False, "a_token": True, "a_api%5Fkey": True, "xPASSWORD": True}.items():
        key = "a" * 300 + short
        assert is_sensitive_key(key) is is_sensitive_key(short) is sensitive
        text = redact_event(make_event(msg=f"{key}=hunter2", ctx={key: "hunter2"}))
        assert ("hunter2" not in json.dumps(text)) is sensitive

    gc.collect()
    tracemalloc.start()
    try:
        before = tracemalloc.get_traced_memory()[0]
        for index in range(4):
            assert is_sensitive_key(f"{index}{'a' * 1_000_000}_token")
        gc.collect()
        retained = tracemalloc.get_traced_memory()[0] - before
    finally:
        tracemalloc.stop()
    assert retained < 100_000


class _Counted(Exception):
    """An error that counts how often its text is built."""

    calls = 0

    def __init__(self, text: str) -> None:
        super().__init__(text)
        self.text = text

    def __str__(self) -> str:
        _Counted.calls += 1
        return self.text


def _chain(length: int) -> _Counted:
    head: _Counted | None = None
    for index in range(length):
        error = _Counted(f"m{index}")
        error.__cause__ = head
        head = error
    assert head is not None
    return head


def test_an_error_stack_is_built_from_the_error_alone() -> None:
    # Each serialized error builds its text once and formats only its own
    # traceback: never the whole cause chain, nor again for every cause.
    _Counted.calls = 0
    serialized = sanitize_value(_chain(10_000))
    assert _Counted.calls == MAX_REDACTION_DEPTH
    assert serialized["stack"] == "_Counted: m9999\n"
    assert serialized["cause"]["stack"] == "_Counted: m9998\n"

    shared = _chain(2)
    first, second = _Counted("first"), _Counted("second")
    first.__cause__ = second.__cause__ = shared
    _Counted.calls = 0
    assert [e["cause"]["message"] for e in sanitize_value([first, second])] == ["m1", "m1"]
    assert _Counted.calls == 6


def test_an_oversized_error_message_is_built_once_and_its_stack_never() -> None:
    _Counted.calls = 0
    big = _Counted("s" * (MAX_TRAVERSAL + 1))
    big.__cause__ = _Counted("cause")
    assert sanitize_value(big) == {"name": "_Counted", "message": "[max-size]", "stack": "[max-size]", "cause": "[max-size]"}
    assert _Counted.calls == 1


def test_an_error_stack_keeps_the_newest_frames_and_is_redacted() -> None:
    def recurse(depth: int) -> None:
        if depth == 0:
            raise ValueError("password=hunter2")
        recurse(depth - 1)

    try:
        recurse(200)
    except ValueError as error:
        failure = error
    stack = redact_event(make_event(ctx={"err": failure}))["ctx"]["err"]["stack"]
    # 64 frames: 63 identical recursive calls (3 written, then a count) and the raise.
    assert "[Previous line repeated 60 more times]" in stack and stack.count('  File "') == 4
    assert stack.startswith("Traceback (most recent call last):\n")
    assert "raise ValueError" not in stack and stack.endswith("ValueError: password=[redacted]\n")
    assert "hunter2" not in stack


def _raise_in_handler(cause: BaseException | None, suppress: bool = False) -> RuntimeError:
    try:
        try:
            raise ValueError("the actual database failure token=abc")
        except ValueError:
            if suppress:
                raise RuntimeError("request failed") from cause
            raise RuntimeError("request failed")  # noqa: B904 - the implicit context is the point
    except RuntimeError as error:
        return error


def test_an_error_keeps_the_chain_python_shows() -> None:
    implicit = redact_event(make_event(ctx={"err": _raise_in_handler(None)}))["ctx"]["err"]
    assert implicit["cause"]["name"] == "ValueError"
    assert implicit["cause"]["message"] == "the actual database failure token=[redacted]"
    assert "abc" not in json.dumps(implicit)

    explicit = sanitize_value(_raise_in_handler(KeyError("lookup"), suppress=True))
    assert explicit["cause"]["name"] == "KeyError"
    assert "database failure" not in json.dumps(explicit)

    assert "cause" not in sanitize_value(_raise_in_handler(None, suppress=True))


def test_an_implicit_chain_is_bounded_like_a_cause_chain() -> None:
    first, second = ValueError("first"), ValueError("second")
    first.__context__, second.__context__ = second, first
    assert sanitize_value(first)["cause"]["cause"] == "[circular]"

    head: _Counted | None = None
    for index in range(10_000):
        error = _Counted(f"m{index}")
        error.__context__ = head
        head = error
    _Counted.calls = 0
    assert "[max-depth]" in json.dumps(sanitize_value(head))
    assert _Counted.calls == MAX_REDACTION_DEPTH


SECRET_URL = "https://user:supersecret" + "x" * 180 + "@host"


def _raise_from(filename: str, function: str, tail: str = "", directory: Path | None = None) -> ValueError:
    # Recurses 100 times in a module named ``filename`` whose lines end in ``tail``, a real file under ``directory``.
    source = f"def recurse(depth):\n    recurse(depth - 1) if depth else fail(){tail}\ndef fail():\n    raise ValueError('boom'){tail}\n"
    if directory is not None:
        filename = str(directory / filename)
        Path(filename).write_text(source)
    namespace: dict[str, Any] = {}
    exec(compile(source, filename, "exec"), namespace)
    namespace["fail"].__code__ = namespace["fail"].__code__.replace(co_name=function)
    try:
        namespace["recurse"](100)
    except ValueError as error:
        return error
    raise AssertionError("not raised")


@pytest.mark.parametrize(
    ("filename", "function", "tail"),
    [
        (SECRET_URL + "/file.py", "fail", ""),
        ("module.py", SECRET_URL, ""),
        ("module.py", "fail", "  # " + "y" * 148 + SECRET_URL),
    ],
    ids=["filename", "function", "source"],
)
def test_an_error_stack_never_cuts_a_credential_out_of_redaction(filename: str, function: str, tail: str, tmp_path: Path) -> None:
    failure = _raise_from(filename, function, tail, tmp_path if tail else None)
    bodies: list[bytes] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    sink = SinkHttp("https://collector.test/ingest", transport=transport)
    sink([make_event(ctx={"err": failure})])
    asyncio.run(sink.flush())
    stack = sanitize_value(failure)["stack"]
    for output in (stack, json.dumps(redact_event(make_event(ctx={"err": failure}))), bodies[0].decode()):
        assert "supersecret" not in output and "ValueError: boom" in output
    assert ("[max-size]" in stack) == (tail == "")  # An overlong name is replaced whole; source is never read.


def test_an_error_stack_reads_no_source_text(tmp_path: Path) -> None:
    # Every frame's source line is about 1M characters, through 100 recursive calls.
    failure = _raise_from("long_lines.py", "fail", "  # password=hunter2 " + "x" * 1_000_000, tmp_path)
    module = tmp_path / "long_lines.py"
    linecache.clearcache()

    tracemalloc.start()
    try:
        stack = sanitize_value(failure)["stack"]
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 200_000
    assert str(module) not in linecache.cache
    assert f'  File "{module}", line 4, in fail\n' in stack and stack.endswith("ValueError: boom\n")
    assert "hunter2" not in stack and "raise ValueError" not in stack
