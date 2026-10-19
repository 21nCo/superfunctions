import json
from datetime import datetime, timezone

from logfn.core import Logger
from logfn.pipeline import redact
from logfn.serialization import sanitize_value


def test_nested_cyclic_redaction_does_not_mutate_application_context():
    events = []
    context = {"nested": [{"token": "secret-123"}]}
    context["self"] = context
    logger = Logger("test", [lambda batch: events.extend(batch)], pipeline=[redact([r"secret-\d+"])])
    logger.info("secret-456", context)
    encoded = json.dumps(events, allow_nan=False)
    assert "secret-" not in encoded
    assert "[redacted]" in encoded
    assert "[circular]" in encoded
    assert context["nested"][0]["token"] == "secret-123"


def test_selected_redaction_keys_cover_nested_values_only_under_selected_roots():
    events = []
    logger = Logger("test", [lambda batch: events.extend(batch)], pipeline=[redact(["secret"], keys=["private"])])
    logger.info("hello", {"private": [{"token": "secret"}], "public": "secret"})
    assert events[0]["ctx"] == {"private": [{"token": "[redacted]"}], "public": "secret"}


def test_sinks_receive_json_safe_values_after_pipeline():
    events = []
    def enrich(event):
        event["ctx"] = {"date": datetime(2026, 1, 1, tzinfo=timezone.utc), "nan": float("nan"), "obj": object()}
        event["ctx"]["cycle"] = event["ctx"]
        return event
    Logger("test", [lambda batch: events.extend(batch)], pipeline=[enrich]).info("hello")
    json.dumps(events, allow_nan=False)
    assert events[0]["ctx"]["nan"] is None
    assert events[0]["ctx"]["obj"] == "[unserializable]"
    assert events[0]["ctx"]["cycle"] == "[circular]"


def test_deep_values_are_bounded_and_repeated_siblings_are_not_cycles():
    shared = {"ok": True}
    assert sanitize_value([shared, shared]) == [shared, shared]
    value = {}
    cursor = value
    for _ in range(1000):
        cursor["child"] = {}
        cursor = cursor["child"]
    assert "[depth_limit]" in json.dumps(sanitize_value(value))


def test_event_size_preserves_small_context_fields_and_limits_tags():
    events = []
    context = {"huge": "😀" * 30000, "useful": {"id": 123}, "tail": True}
    Logger("test", [lambda batch: events.extend(batch)]).info("hello", context, tags=["tag"] * 30)
    event = events[0]
    assert len(json.dumps(event).encode("utf-8")) <= 65536
    assert event["ctx"] == {"_truncated": True, "_reason": "size_limit", "useful": {"id": 123}, "tail": True}
    assert len(event["tags"]) <= 20
    assert len(context["huge"]) == 30000


def test_oversized_envelope_is_bounded_without_cutting_unicode_points():
    events = []
    Logger("界" * 30000, [lambda batch: events.extend(batch)]).info("😀" * 30000)
    event = events[0]
    assert len(json.dumps(event).encode("utf-8")) <= 65536
    assert len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= 65536
    assert event["msg"] and set(event["msg"]) == {"😀"}
    assert event["name"] and set(event["name"]) == {"界"}
    assert event["ctx"]["_truncated"] is True


def test_twenty_tag_limit_applies_even_when_event_is_small():
    events = []
    Logger("test", [lambda batch: events.extend(batch)]).info("hello", tags=[str(i) for i in range(30)])
    assert events[0]["tags"] == [str(i) for i in range(20)]


def test_integer_conversion_limit_does_not_break_logging_or_drop_other_context():
    import sys
    import pytest

    if not hasattr(sys, "set_int_max_str_digits"):
        pytest.skip("Runtime has no integer conversion limit")
    previous = sys.get_int_max_str_digits()
    context = {"huge": 10 ** 5000, "useful": 123, "negative": -(10 ** 5000)}
    events = []
    try:
        sys.set_int_max_str_digits(640)
        Logger("test", [lambda batch: events.extend(batch)]).info("hello", context)
        assert events[0]["ctx"] == {
            "huge": "[unserializable]", "useful": 123, "negative": "[unserializable]"
        }
        assert sys.get_int_max_str_digits() == 640
        json.dumps(events, allow_nan=False)
        assert context["huge"] == 10 ** 5000
    finally:
        sys.set_int_max_str_digits(previous)
