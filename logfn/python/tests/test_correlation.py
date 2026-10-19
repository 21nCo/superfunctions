import re

from logfn import LogCorrelation, Logger, create_logger, with_request_ids


def test_top_level_correlation_inheritance_and_input_isolation():
    events = []
    ids: LogCorrelation = {
        "traceId": "a" * 32, "spanId": "b" * 16, "requestId": "request",
        "userId": "parent", "tenantId": "tenant",
    }
    logger = create_logger("app", [events.extend], correlation=ids)
    ids["requestId"] = "mutated"
    override: LogCorrelation = {"userId": "child"}
    child = logger.child(correlation=override)
    override["userId"] = "mutated"
    child.child().info("child", ctx={"requestId": "context-only"})
    logger.info("parent")
    assert events[0]["userId"] == "child"
    assert events[1]["userId"] == "parent"
    for event in events:
        assert event["traceId"] == "a" * 32
        assert event["spanId"] == "b" * 16
        assert event["requestId"] == "request"
        assert event["tenantId"] == "tenant"
    assert events[0]["ctx"]["requestId"] == "context-only"


def test_direct_logger_correlation_reaches_pipeline():
    events = []
    logger = Logger("app", [events.extend], correlation={"requestId": "supplied"},
                    pipeline=[with_request_ids()])
    logger.info("first")
    logger.info("second")
    assert all(event["requestId"] == "supplied" for event in events)
    assert all(re.fullmatch(r"[0-9a-f]{32}", event["traceId"]) for event in events)
    assert events[0]["traceId"] != events[1]["traceId"]


def test_request_ids_preserve_supplied_values_and_generation_controls():
    events = []
    create_logger("app", [events.extend], correlation={"traceId": "external-trace"},
                  pipeline=[with_request_ids()]).info("partial")
    assert events[0]["traceId"] == "external-trace"
    assert events[0]["requestId"]
    create_logger("app", [events.extend],
                  pipeline=[with_request_ids(False, False)]).info("disabled")
    assert "traceId" not in events[1] and "requestId" not in events[1]
