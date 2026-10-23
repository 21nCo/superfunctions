"""Exported spans preserve context without exposing user payloads."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from flowfn import create_flow
from flowfn.adapters.base import FlowAdapter
from flowfn.adapters.memory import MemoryAdapter
from flowfn.core.telemetry import OperationObserver
from flowfn.queue.types import Job
from flowfn.stream.types import ConsumerOptions, Message
from flowfn.workflow.types import WorkflowContext
from tests.native_support import NativeAdapters


async def check_telemetry(adapter: FlowAdapter) -> None:
    trace = pytest.importorskip("opentelemetry.trace")
    pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    errors = []
    flow = create_flow(
        adapter,
        telemetry={"enabled": True, "tracer_provider": provider},
        on_error=lambda error, details: errors.append(details["operation"]),
    )
    if hasattr(adapter, "reclaim_after_ms"):
        adapter.reclaim_after_ms = 5000
    try:
        queue = flow.queue("traced")

        async def handler(job: Job) -> int:
            span = trace.get_current_span()
            assert span.is_recording()
            await queue.get_job_counts()
            assert trace.get_current_span() is span
            if job.name == "failure":
                raise ValueError("expected failure")
            return 7

        for name in ["success", "failure"]:
            await queue.add(name, {"secret": "never-export"})
            job = await flow._adapter.dequeue(queue.name)
            assert job is not None
            await queue._process_job(job, handler)

        async def step(context: WorkflowContext) -> None:
            assert trace.get_current_span().is_recording()
            await queue.get_job_counts()

        workflow = flow.workflow("traced").step("work", step).build()
        execution = await workflow.execute({"secret": "never-export"})
        await asyncio.wait_for(workflow._tasks[execution.id], 10)
        stream = flow.stream("traced")
        received = asyncio.Event()

        async def message_handler(message: Message) -> None:
            assert trace.get_current_span().is_recording()
            await message.ack()
            received.set()

        consumer = stream.create_consumer("reader", ConsumerOptions(group_id="g", max_in_flight=1))
        await consumer.subscribe(message_handler)
        await stream.publish({"secret": "never-export"})
        await asyncio.wait_for(received.wait(), 10)
        await consumer.close()
        provider.force_flush()
        spans = exporter.get_finished_spans()
        jobs = [span for span in spans if span.name == "flowfn.job.execute"]
        assert len(jobs) == 2
        assert any(span.status.status_code == trace.StatusCode.ERROR for span in jobs)
        assert any(
            span.name == "flowfn.adapter.get_queue_stats"
            and span.parent.span_id == jobs[0].context.span_id
            for span in spans
            if span.parent
        )
        assert any(span.name == "flowfn.workflow.step" for span in spans)
        assert any(span.name == "flowfn.stream.message" for span in spans)
        assert "flowfn.job.execute" in errors
        assert "never-export" not in str([dict(span.attributes or {}) for span in spans])
    finally:
        await flow.close()
        provider.shutdown()


async def test_memory_telemetry() -> None:
    await check_telemetry(MemoryAdapter())


async def test_native_telemetry(adapters: NativeAdapters) -> None:
    await check_telemetry(adapters[0])


@pytest.mark.parametrize("failure", ["enter", "exit"])
async def test_broken_instrumentation_never_replays_or_masks_application(failure: str) -> None:
    class Tracer:
        def start_as_current_span(self, *args: Any, **kwargs: Any) -> Tracer:
            return self

        def __enter__(self) -> None:
            if failure == "enter":
                raise RuntimeError("tracer enter")

        def __exit__(self, *args: Any) -> None:
            if failure == "exit":
                raise RuntimeError("tracer exit")

    count = 0

    async def work() -> None:
        nonlocal count
        count += 1
        raise ValueError("application")

    async def broken_callback(*args: Any) -> None:
        raise RuntimeError("callback")

    observer = OperationObserver(
        {"enabled": True, "provider": "custom", "tracer": Tracer()}, broken_callback
    )
    with pytest.raises(ValueError, match="application"):
        await observer.run("test", {}, work)
    assert count == 1


async def test_disabled_telemetry_and_callback_without_tracing() -> None:
    events = []
    observer = OperationObserver(
        {"enabled": False, "provider": "invalid"}, lambda e, details: events.append(details)
    )

    async def fail() -> None:
        raise ValueError("expected")

    with pytest.raises(ValueError):
        await observer.run("operation", {}, fail)
    assert events == [{"operation": "operation"}]
    with pytest.raises(ValueError, match="requires a tracer"):
        OperationObserver({"enabled": True, "provider": "custom"})
