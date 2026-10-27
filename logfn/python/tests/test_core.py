import asyncio
from datetime import datetime, timezone
from typing import Any

import pytest

from logfn import Logger, create_logger
from logfn.types import LogEvent


class MockSink:
    def __init__(self) -> None:
        self.events: list[LogEvent] = []

    def __call__(self, batch: list[LogEvent]) -> None:
        self.events.extend(batch)


def fixed_now() -> datetime:
    return datetime(2026, 1, 14, 12, 0, 0, 123456, tzinfo=timezone.utc)


def test_levels_and_event_shape() -> None:
    sink = MockSink()
    logger = create_logger("svc", sinks=[sink], level="warn", now=fixed_now)
    for level in ("trace", "debug", "info", "warn", "error", "fatal"):
        getattr(logger, level)(level)
    assert [e["level"] for e in sink.events] == ["warn", "error", "fatal"]
    assert sink.events[0] == {"ts": "2026-01-14T12:00:00.123Z", "level": "warn", "msg": "warn", "name": "svc", "version": "0"}


def test_unknown_level_is_rejected() -> None:
    with pytest.raises(ValueError, match="Unknown log level"):
        create_logger("svc", level="verbose")  # type: ignore[arg-type]


def test_context_kwargs_child_and_tags() -> None:
    sink = MockSink()
    logger = create_logger("svc", sinks=[sink], level="info", base_context={"env": "prod", "a": 1}, base_tags=["base"])
    child = logger.child(name="child", ctx={"module": "auth", "a": 2}, tags=["child"])
    child.debug("hidden")
    child.info("login", {"a": 3}, ["call"], user_id="123")
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event["name"] == "child"
    assert event["ctx"] == {"env": "prod", "module": "auth", "a": 3, "user_id": "123"}
    assert event["tags"] == ["base", "child", "call"]


def test_exception_or_scalar_context_is_kept() -> None:
    sink = MockSink()
    logger = create_logger("svc", sinks=[sink])
    logger.error("failed", ValueError("boom"))
    logger.info("odd", "text")
    assert sink.events[0]["ctx"]["error"]["name"] == "ValueError"
    assert sink.events[0]["ctx"]["error"]["message"] == "boom"
    assert sink.events[1]["ctx"] == {"value": "text"}


def test_pipeline_order_and_drop() -> None:
    sink = MockSink()

    def mark(suffix: str) -> Any:
        return lambda e: {**e, "msg": e["msg"] + suffix}

    logger = create_logger(
        "svc",
        sinks=[sink],
        pipeline=[mark("-1"), lambda e: None if e["msg"].startswith("drop") else e, mark("-2")],
    )
    logger.info("keep")
    logger.info("drop")
    assert [e["msg"] for e in sink.events] == ["keep-1-2"]


def test_failing_stage_drops_the_event_and_reports() -> None:
    sink = MockSink()
    errors: list[tuple[BaseException, dict[str, str]]] = []

    def broken_redactor(event: LogEvent) -> LogEvent:
        raise RuntimeError("stage failed")

    logger = create_logger("svc", sinks=[sink], pipeline=[broken_redactor], on_error=lambda e, c: errors.append((e, c)))
    logger.info("password=hunter2")
    assert sink.events == []
    assert str(errors[0][0]) == "stage failed"
    assert errors[0][1] == {"stage": "broken_redactor"}


def test_sink_failures_are_isolated() -> None:
    sink = MockSink()
    errors: list[str] = []

    def throwing(batch: list[LogEvent]) -> None:
        raise RuntimeError("sync sink")

    async def rejecting(batch: list[LogEvent]) -> None:
        raise RuntimeError("async sink")

    def handler(error: BaseException, context: dict[str, str]) -> None:
        errors.append(str(error))
        raise RuntimeError("handler broke")

    # Outside an event loop the async sink cannot run and is reported.
    logger = create_logger("svc", sinks=[throwing, rejecting, sink], on_error=handler)
    logger.info("m")
    assert len(sink.events) == 1
    assert "sync sink" in errors
    assert any("no event loop" in message for message in errors)

    async def inside_loop() -> None:
        logger.info("m2")
        await logger.flush()

    asyncio.run(inside_loop())
    assert "async sink" in errors
    assert len(sink.events) == 2


def test_flush_reports_failures_without_raising() -> None:
    flushed: list[str] = []
    errors: list[str] = []

    class Good(MockSink):
        async def flush(self) -> None:
            flushed.append("good")

    class Bad(MockSink):
        def flush(self) -> None:
            raise RuntimeError("flush failed")

    logger = create_logger("svc", sinks=[Bad(), Good()], on_error=lambda e, c: errors.append(str(e)))
    asyncio.run(logger.flush())
    assert flushed == ["good"]
    assert errors == ["flush failed"]


def test_default_sink_is_local_console(capsys: pytest.CaptureFixture[str]) -> None:
    logger = Logger("svc", level="info")
    logger.info("hello")
    assert "hello" in capsys.readouterr().out


def test_circular_context_is_sanitized() -> None:
    sink = MockSink()
    logger = create_logger("svc", sinks=[sink])
    ctx: dict[str, Any] = {"id": 1}
    ctx["self"] = ctx
    logger.info("cyclic", ctx)
    # The logger merges ctx into a new top-level dict, so the caller's dict
    # appears once more before its back-reference is cut.
    assert sink.events[0]["ctx"] == {"id": 1, "self": {"id": 1, "self": "[circular]"}}
