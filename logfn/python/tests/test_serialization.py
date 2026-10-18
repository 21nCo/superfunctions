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
