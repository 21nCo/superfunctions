import asyncio
import threading
import time
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


def test_no_tags_field_without_tags_also_for_child_loggers() -> None:
    sink = MockSink()
    logger = create_logger("svc", sinks=[sink])
    logger.info("root", None, [])
    logger.child(ctx={"module": "auth"}).info("child")
    assert len(sink.events) == 2
    assert all("tags" not in event for event in sink.events)


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


class _RaisingName:
    """A sink or stage whose __name__ property raises."""

    def __init__(self, fail: str) -> None:
        self.fail = fail

    @property
    def __name__(self) -> str:
        raise RuntimeError("name property")

    def __call__(self, value: Any) -> Any:
        if self.fail in ("sync", "stage"):
            raise ValueError(f"{self.fail} failed")
        if self.fail == "async":

            async def failing() -> None:
                raise ValueError("async failed")

            return failing()
        return None

    async def flush(self) -> None:
        if self.fail == "flush":
            raise ValueError("flush failed")


@pytest.mark.parametrize("fail", ["sync", "async", "flush", "stage"])
def test_a_raising_name_property_does_not_hide_the_reported_error(fail: str) -> None:
    errors: list[tuple[str, dict[str, str]]] = []
    flushed: list[str] = []

    class Good(MockSink):
        async def flush(self) -> None:
            flushed.append("good")

    loop_errors: list[dict[str, Any]] = []
    broken = _RaisingName(fail)
    sinks: list[Any] = [Good()] if fail == "stage" else [broken, Good()]
    pipeline: list[Any] = [broken] if fail == "stage" else []
    logger = create_logger("svc", sinks=sinks, pipeline=pipeline, on_error=lambda e, c: errors.append((str(e), c)))

    async def run() -> None:
        asyncio.get_running_loop().set_exception_handler(lambda _loop, context: loop_errors.append(context))
        if fail != "flush":
            logger.info("m")
        await logger.flush()

    asyncio.run(run())
    expected = {"stage": "unknown"} if fail == "stage" else {"sink": "unknown"}
    assert errors == [(f"{fail} failed", expected)]
    assert flushed == ["good"]
    assert loop_errors == []


def test_a_raising_flush_property_is_reported_and_siblings_still_flush() -> None:
    errors: list[tuple[str, dict[str, str]]] = []
    flushed: list[str] = []

    class FlushProperty(MockSink):
        @property
        def flush(self) -> Any:
            raise RuntimeError("flush property")

    class Good(MockSink):
        async def flush(self) -> None:
            flushed.append("good")

    logger = create_logger("svc", sinks=[FlushProperty(), Good()], on_error=lambda e, c: errors.append((str(e), c)))
    logger.info("m")
    asyncio.run(logger.flush())
    assert errors == [("flush property", {"sink": "FlushProperty"})]
    assert flushed == ["good"]


async def _cancelled_by_the_sink() -> None:
    # The sink awaits a future that was cancelled; nobody cancelled the caller.
    future = asyncio.get_running_loop().create_future()
    future.cancel()
    await future


@pytest.mark.parametrize("where", ["call", "flush"])
def test_a_cancelled_error_raised_by_a_sink_is_that_sinks_failure(where: str) -> None:
    errors: list[tuple[str, dict[str, str]]] = []
    done: list[str] = []

    class Cancelling(MockSink):
        def __call__(self, batch: list[LogEvent]) -> Any:
            return _cancelled_by_the_sink() if where == "call" else None

        async def flush(self) -> None:
            if where == "flush":
                await _cancelled_by_the_sink()

    class Slow(MockSink):
        async def flush(self) -> None:
            await asyncio.sleep(0.05)
            done.append("slow")

    logger = create_logger(
        "svc", sinks=[Cancelling(), Slow()], on_error=lambda e, c: errors.append((type(e).__name__, c))
    )

    async def main() -> None:
        logger.info("m")
        await logger.flush()  # Resolves: the sink's cancellation is not the caller's.

    asyncio.run(main())
    assert errors == [("CancelledError", {"sink": "Cancelling"})]
    assert done == ["slow"]


def test_cancelling_flush_itself_still_propagates() -> None:
    started = asyncio.Event()
    cancelled: list[str] = []

    class Hanging(MockSink):
        async def flush(self) -> None:
            started.set()
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                cancelled.append("hanging")
                raise

    errors: list[BaseException] = []
    logger = create_logger("svc", sinks=[Hanging()], on_error=lambda e, c: errors.append(e))

    async def main() -> None:
        flushing = asyncio.get_running_loop().create_task(logger.flush())
        await started.wait()
        flushing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await flushing

    asyncio.run(main())
    assert cancelled == ["hanging"] and errors == []


class _CancellingName:
    """A sink whose call fails and whose __name__ raises CancelledError."""

    @property
    def __name__(self) -> str:
        raise asyncio.CancelledError

    def __call__(self, batch: list[LogEvent]) -> None:
        raise RuntimeError("sink failed")


def _cancelling_sink(batch: list[LogEvent]) -> None:
    raise asyncio.CancelledError


def _cancelling_stage(event: LogEvent) -> LogEvent:
    raise asyncio.CancelledError


@pytest.mark.parametrize("where", ["sink", "stage", "on_error", "name"])
def test_a_cancelled_error_raised_synchronously_by_caller_code_is_its_failure(where: str) -> None:
    # A synchronous call cannot be cancelled from outside, so a CancelledError
    # it raises is that component's failure: the logging call does not raise,
    # sibling sinks still get the event, and a failing stage drops it.
    sink = MockSink()
    errors: list[tuple[str, dict[str, str]]] = []

    def on_error(error: BaseException, context: dict[str, str]) -> None:
        errors.append((type(error).__name__, context))
        if where == "on_error":
            raise asyncio.CancelledError

    first: Any = {"sink": _cancelling_sink, "name": _CancellingName()}.get(where, MockSink())
    pipeline: Any = [_cancelling_stage] if where in ("stage", "on_error") else []
    logger = create_logger("svc", sinks=[first, sink], pipeline=pipeline, on_error=on_error)
    logger.info("m")
    logger.info("m")
    expected = {
        "sink": ("CancelledError", {"sink": "_cancelling_sink"}),
        "name": ("RuntimeError", {"sink": "unknown"}),
    }.get(where, ("CancelledError", {"stage": "_cancelling_stage"}))
    assert errors == [expected, expected]
    assert len(sink.events) == (0 if where in ("stage", "on_error") else 2)


@pytest.mark.parametrize("via", ["own loop", "child", "other loop"])
def test_cancelling_flush_while_it_waits_for_logged_calls_does_not_cancel_them(via: str) -> None:
    # Cancelling flush() ends the wait only: the sink calls made by logging
    # keep running and still deliver.
    gate = threading.Event()
    delivered: list[str] = []

    async def slow(batch: list[LogEvent]) -> None:
        while not gate.is_set():
            await asyncio.sleep(0.005)
        delivered.extend(event["msg"] for event in batch)

    logger = create_logger("svc", sinks=[slow])
    stop = threading.Event()
    logged = threading.Event()

    def other_loop() -> None:
        async def main() -> None:
            logger.info("m")
            logged.set()
            while not stop.is_set():
                await asyncio.sleep(0.005)

        asyncio.run(main())

    thread = threading.Thread(target=other_loop, daemon=True)

    async def main() -> None:
        if via == "other loop":
            thread.start()
            assert logged.wait(5)
        else:
            (logger.child(name="child") if via == "child" else logger).info("m")
        flushing = asyncio.ensure_future(logger.flush())
        await asyncio.sleep(0.1)
        assert not flushing.done()
        flushing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await flushing
        gate.set()
        deadline = time.monotonic() + 5
        while delivered != ["m"]:
            assert time.monotonic() < deadline, "the logged call was cancelled with flush()"
            await asyncio.sleep(0.005)

    try:
        asyncio.run(main())
    finally:
        gate.set()
        stop.set()
        if thread.is_alive():
            thread.join(5)


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


def test_keys_that_sanitize_to_the_same_text_keep_every_value() -> None:
    sink = MockSink()
    create_logger("svc", sinks=[sink]).info("ids", by_id={1: "numeric", "1": "text"})
    assert sink.events[0]["ctx"] == {"by_id": {"1": "numeric", "1#2": "text"}}


def test_any_context_keyword_is_accepted() -> None:
    sink = MockSink()
    errors: list[BaseException] = []
    logger = create_logger("svc", sinks=[sink], on_error=lambda error, context: errors.append(error))
    logger.info("login", level="admin", msg="shadow", name="ada", kwargs=1)
    logger.warn("keywords", ctx={"a": 1}, tags=["t"], user_id="1")
    logger.error("odd tags", tags=5)  # type: ignore[arg-type]
    assert errors == []
    assert sink.events[0]["msg"] == "login" and sink.events[0]["level"] == "info"
    assert sink.events[0]["ctx"] == {"level": "admin", "msg": "shadow", "name": "ada", "kwargs": 1}
    assert sink.events[1]["ctx"] == {"a": 1, "user_id": "1"} and sink.events[1]["tags"] == ["t"]
    assert "tags" not in sink.events[2]


def test_flush_waits_for_async_sink_calls_made_through_a_child() -> None:
    delivered: list[str] = []

    async def scenario() -> None:
        gate = asyncio.Event()

        async def slow(batch: list[LogEvent]) -> None:
            if batch[0]["name"] == "child":
                await gate.wait()
            delivered.extend(event["msg"] for event in batch)

        logger = create_logger("svc", sinks=[slow])
        logger.child(name="child").info("child")
        logger.info("root")
        flushing = asyncio.ensure_future(logger.flush())
        await asyncio.sleep(0.01)
        assert not flushing.done()
        gate.set()
        await flushing

    asyncio.run(scenario())
    assert delivered == ["root", "child"]



def test_flush_waits_for_async_sink_calls_running_on_another_loop() -> None:
    gate = threading.Event()
    delivered: list[str] = []

    async def slow(batch: list[LogEvent]) -> None:
        await asyncio.to_thread(gate.wait, 5)
        delivered.extend(event["msg"] for event in batch)

    logger = create_logger("svc", sinks=[slow])
    logged = threading.Event()
    stop = threading.Event()

    def loop_a() -> None:
        async def main() -> None:
            logger.child(name="child").info("before flush")
            logged.set()
            while not stop.is_set():
                await asyncio.sleep(0.01)

        asyncio.run(main())

    thread = threading.Thread(target=loop_a, daemon=True)
    thread.start()
    assert logged.wait(5)

    async def flush_on_b() -> None:
        flushing = asyncio.ensure_future(logger.flush())
        await asyncio.sleep(0.2)
        assert not flushing.done(), "flush returned before the call on loop A settled"
        gate.set()
        await asyncio.wait_for(flushing, 5)

    try:
        asyncio.run(flush_on_b())
        assert delivered == ["before flush"]
    finally:
        gate.set()
        stop.set()
        thread.join(5)


def test_flush_does_not_wait_for_calls_whose_loop_stopped_or_closed() -> None:
    async def never(batch: list[LogEvent]) -> None:
        await asyncio.Event().wait()

    logger = create_logger("svc", sinks=[never])
    stopped = asyncio.new_event_loop()
    closed = asyncio.new_event_loop()

    async def log() -> None:
        logger.info("pending")

    try:
        stopped.run_until_complete(log())  # Stopped, not closed: its call stays pending.
        closed.run_until_complete(log())
        closed.close()
        started = time.monotonic()
        asyncio.run(asyncio.wait_for(logger.flush(), 5))
        assert time.monotonic() - started < 1
    finally:
        for task in asyncio.all_tasks(stopped):
            task.cancel()
        stopped.run_until_complete(asyncio.sleep(0))
        stopped.close()


def test_on_error_is_not_reentered_by_a_failure_it_causes(capsys: pytest.CaptureFixture[str]) -> None:
    # An on_error that logs through the failing sink fails again; that nested
    # failure goes to the stderr reporter, not back into on_error.
    calls: list[str] = []

    def failing(batch: list[LogEvent]) -> None:
        raise RuntimeError("sink down")

    def on_error(error: BaseException, context: dict[str, str]) -> None:
        calls.append(str(error))
        logger.error("sink failed", ctx={"error": str(error)})

    logger = create_logger("svc", sinks=[failing], on_error=on_error)
    logger.info("one")
    logger.info("two")
    assert calls == ["sink down", "sink down"]
    assert capsys.readouterr().err.count("[logfn internal error]") == 2


@pytest.mark.parametrize("via", ["logger", "child"])
def test_on_error_is_not_reentered_by_an_async_sink_failure_it_causes(
    via: str, capsys: pytest.CaptureFixture[str]
) -> None:
    # The failure of a sink call made while on_error ran surfaces in a later
    # task, after the handler returned; it must still not call that handler.
    calls: list[str] = []
    sink_calls = 0

    async def failing(batch: list[LogEvent]) -> None:
        nonlocal sink_calls
        sink_calls += 1
        raise RuntimeError("sink down")

    def on_error(error: BaseException, context: dict[str, str]) -> None:
        calls.append(str(error))
        target.error("sink failed", ctx={"error": str(error)})

    root = create_logger("svc", sinks=[failing], on_error=on_error)
    target = root.child(name="child") if via == "child" else root

    async def scenario() -> None:
        target.info("one event")
        await target.flush()
        await asyncio.sleep(0.05)
        assert calls == ["sink down"]
        assert sink_calls == 2
        assert capsys.readouterr().err.count("[logfn internal error]") == 1

        # A later independent failure is still reported to on_error.
        target.info("two")
        await target.flush()
        await asyncio.sleep(0.05)
        assert calls == ["sink down", "sink down"]
        assert sink_calls == 4

    asyncio.run(scenario())


@pytest.mark.parametrize("via", ["logger", "child"])
def test_on_error_is_not_reentered_by_a_flush_failure_of_a_flush_it_started(
    via: str, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[str] = []
    flushes = 0

    class Failing:
        def __call__(self, batch: list[LogEvent]) -> None:
            pass

        async def flush(self) -> None:
            nonlocal flushes
            flushes += 1
            raise RuntimeError("flush down")

    def on_error(error: BaseException, context: dict[str, str]) -> None:
        calls.append(str(error))
        if len(calls) <= 10:  # Keeps a regression finite.
            asyncio.get_running_loop().create_task(target.flush())

    root = create_logger("svc", sinks=[Failing()], on_error=on_error)
    target = root.child(name="child") if via == "child" else root

    async def scenario() -> None:
        await target.flush()
        await asyncio.sleep(0.05)
        assert calls == ["flush down"]
        assert flushes == 2
        assert capsys.readouterr().err.count("[logfn internal error]") == 1

        # A later independent flush failure is still reported to on_error.
        await target.flush()
        await asyncio.sleep(0.05)
        assert calls == ["flush down", "flush down"]
        assert flushes == 4

    asyncio.run(scenario())


def test_a_reporting_cycle_between_two_loggers_stops() -> None:
    # Handlers that log through each other's failing async sinks: the
    # provenance is carried through both tasks, so the cycle ends.
    calls: list[str] = []
    sink_calls = 0

    async def failing(batch: list[LogEvent]) -> None:
        nonlocal sink_calls
        sink_calls += 1
        raise RuntimeError("down")

    def on_error_a(error: BaseException, context: dict[str, str]) -> None:
        calls.append("a")
        b.error("a failed")

    def on_error_b(error: BaseException, context: dict[str, str]) -> None:
        calls.append("b")
        a.error("b failed")

    a = create_logger("a", sinks=[failing], on_error=on_error_a)
    b = create_logger("b", sinks=[failing], on_error=on_error_b)

    async def scenario() -> None:
        a.info("one event")
        await asyncio.sleep(0.05)

    asyncio.run(scenario())
    assert calls == ["a", "b"]
    assert sink_calls == 3


def test_a_non_dict_context_or_non_list_tags_are_never_spread() -> None:
    sink = MockSink()
    logger = create_logger("svc", sinks=[sink], base_context="base", base_tags="ab")  # type: ignore[arg-type]
    logger.child(ctx="child", tags="cd").info("m", None, "ef")  # type: ignore[arg-type]
    logger.child().info("plain")
    assert sink.events[0]["ctx"] == {"value": "child"}
    assert sink.events[1]["ctx"] == {"value": "base"}
    assert all("tags" not in event for event in sink.events)


@pytest.mark.parametrize("via", ["logger", "child"])
def test_flush_waits_for_sink_calls_that_on_error_starts_while_it_drains(via: str) -> None:
    delivered: list[str] = []

    async def failing(batch: list[LogEvent]) -> None:
        raise RuntimeError("down")

    async def slow(batch: list[LogEvent]) -> None:
        # Only the diagnostic is slow, so it is still running when the first round of waiting ends.
        if any(event["msg"].startswith("failed") for event in batch):
            await asyncio.sleep(0.05)
        delivered.extend(event["msg"] for event in batch)

    root = create_logger("svc", sinks=[failing], on_error=lambda error, context: target.warn(f"failed: {error}"))
    target = root.child() if via == "child" else root
    # on_error logs through a second async sink of the same logger tree.
    target.sinks.append(slow)

    async def scenario() -> None:
        target.info("event")
        await target.flush()
        # The diagnostic on_error logged while flush drained is delivered before flush returns.
        assert "failed: down" in delivered

    asyncio.run(scenario())


def test_an_on_error_that_keeps_logging_still_lets_flush_return() -> None:
    async def failing(batch: list[LogEvent]) -> None:
        raise RuntimeError("down")

    logger = create_logger("svc", sinks=[failing], on_error=lambda error, context: logger.warn("again"))

    async def scenario() -> None:
        logger.info("event")
        await asyncio.wait_for(logger.flush(), 5)

    asyncio.run(scenario())


@pytest.mark.parametrize("via", ["logger", "child"])
def test_a_sink_that_awaits_flush_does_not_wait_for_its_own_call(via: str) -> None:
    flushed: list[str] = []

    async def scenario() -> None:
        async def sink(batch: list[LogEvent]) -> None:
            await asyncio.wait_for(flusher.flush(), 2)
            flushed.extend(event["msg"] for event in batch)

        logger = create_logger("svc", sinks=[sink], on_error=lambda error, context: flushed.append(repr(error)))
        flusher = logger.child(name="child") if via == "child" else logger
        flusher.info("a")
        await asyncio.wait_for(logger.flush(), 2)

    asyncio.run(scenario())
    assert flushed == ["a"]


def test_sinks_that_await_flush_do_not_wait_for_each_other() -> None:
    flushed: list[str] = []

    async def scenario() -> None:
        running: list[str] = []
        both = asyncio.Event()

        async def sink(batch: list[LogEvent]) -> None:
            running.append(batch[0]["msg"])
            if len(running) == 2:
                both.set()
            await both.wait()  # Both calls are running before either flushes.
            await asyncio.wait_for(logger.flush(), 2)
            flushed.extend(event["msg"] for event in batch)

        logger = create_logger("svc", sinks=[sink], on_error=lambda error, context: flushed.append(repr(error)))
        logger.info("a")
        logger.info("b")
        await asyncio.wait_for(logger.flush(), 2)

    asyncio.run(scenario())
    assert sorted(flushed) == ["a", "b"]


def test_a_flush_a_sink_awaits_still_waits_for_other_calls() -> None:
    order: list[str] = []

    async def scenario() -> None:
        gate = asyncio.Event()

        async def sink(batch: list[LogEvent]) -> None:
            if batch[0]["msg"] == "slow":
                await gate.wait()
                order.append("slow sent")
                return
            asyncio.get_running_loop().call_later(0.05, gate.set)
            await logger.flush()
            order.append("flush returned")

        logger = create_logger("svc", sinks=[sink])
        logger.info("slow")
        logger.info("flushing")
        await asyncio.wait_for(logger.flush(), 2)

    asyncio.run(scenario())
    assert order == ["slow sent", "flush returned"]


@pytest.mark.parametrize("via", ["logger", "child"])
def test_an_overlapping_flush_does_not_end_the_exclusion_of_a_flushing_call(via: str) -> None:
    # Sink A flushes the logger, completes a flush of another logger meanwhile, then lets
    # sink B flush the logger: A is still flushing, so B must not wait for it.
    delivered: list[str] = []

    async def scenario() -> None:
        start_b = asyncio.Event()

        async def sink(batch: list[LogEvent]) -> None:
            if batch[0]["msg"] == "a":
                waiting = asyncio.ensure_future(flusher.flush())
                await asyncio.sleep(0)  # A's drain is open and waits for B.
                await asyncio.wait_for(auxiliary.flush(), 2)
                start_b.set()
                await asyncio.wait_for(waiting, 2)
            else:
                await start_b.wait()
                await asyncio.wait_for(flusher.flush(), 2)
            delivered.append(batch[0]["msg"])

        logger = create_logger("svc", sinks=[sink], on_error=lambda error, context: delivered.append(repr(error)))
        auxiliary = create_logger("aux", sinks=[MockSink()])
        flusher = logger.child(name="child") if via == "child" else logger
        logger.info("a")
        logger.info("b")
        await asyncio.wait_for(logger.flush(), 5)

    asyncio.run(scenario())
    assert sorted(delivered) == ["a", "b"]


@pytest.mark.parametrize("via", ["logger", "child", "other loop"])
def test_a_flush_outside_sinks_waits_for_a_call_that_is_flushing(via: str) -> None:
    # Sink A awaits another logger's flush, held by a gate. A flush made outside
    # every sink call must still wait for A's delivery.
    gate = threading.Event()
    flushing = threading.Event()
    delivered: list[str] = []

    async def held(batch: list[LogEvent]) -> None:
        await asyncio.to_thread(gate.wait, 5)

    other = create_logger("other", sinks=[held])

    async def sink(batch: list[LogEvent]) -> None:
        other.info("held")
        flushing.set()
        await other.flush()
        delivered.append(batch[0]["msg"])

    logger = create_logger("svc", sinks=[sink], on_error=lambda error, context: delivered.append(repr(error)))
    flusher = logger if via == "logger" else logger.child(name="child")
    stop = threading.Event()

    def other_loop() -> None:
        async def main() -> None:
            flusher.info("a")
            while not stop.is_set():
                await asyncio.sleep(0.01)

        asyncio.run(main())

    async def scenario() -> None:
        if via == "other loop":
            threading.Thread(target=other_loop, daemon=True).start()
        else:
            flusher.info("a")
        assert await asyncio.to_thread(flushing.wait, 5)
        await asyncio.sleep(0.05)  # A is inside its flush.
        outer = asyncio.ensure_future(flusher.flush())
        await asyncio.sleep(0.2)
        returned_early = outer.done()
        gate.set()
        await asyncio.wait_for(outer, 5)
        assert not returned_early, "flush returned while a flushing sink call was still delivering"
        assert delivered == ["a"]

    try:
        asyncio.run(scenario())
    finally:
        gate.set()
        stop.set()
