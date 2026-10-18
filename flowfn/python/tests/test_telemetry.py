"""Exported spans preserve context without exposing user payloads."""

import asyncio

import pytest

from flowfn import create_flow
from flowfn.adapters.memory import MemoryAdapter
from flowfn.core.telemetry import OperationObserver
from flowfn.stream.types import ConsumerOptions
from tests.test_durable_adapters import adapters  # noqa: F401


async def check_telemetry(adapter):
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

        async def handler(job):
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
            await queue._process_job(job, handler)

        async def step(context):
            assert trace.get_current_span().is_recording()
            await queue.get_job_counts()

        workflow = flow.workflow("traced").step("work", step).build()
        execution = await workflow.execute({"secret": "never-export"})
        await asyncio.wait_for(workflow._tasks[execution.id], 10)
        stream = flow.stream("traced")
        received = asyncio.Event()

        async def message_handler(message):
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
        assert "never-export" not in str([dict(span.attributes) for span in spans])
    finally:
        await flow.close()
        provider.shutdown()


async def test_memory_telemetry():
    await check_telemetry(MemoryAdapter())


async def test_native_telemetry(adapters):
    await check_telemetry(adapters[0])


@pytest.mark.parametrize("failure", ["enter", "exit"])
async def test_broken_instrumentation_never_replays_or_masks_application(failure):
    class Tracer:
        def start_as_current_span(self, *args, **kwargs):
            return self

        def __enter__(self):
            if failure == "enter":
                raise RuntimeError("tracer enter")

        def __exit__(self, *args):
            if failure == "exit":
                raise RuntimeError("tracer exit")

    count = 0

    async def work():
        nonlocal count
        count += 1
        raise ValueError("application")

    async def broken_callback(*args):
        raise RuntimeError("callback")

    observer = OperationObserver(
        {"enabled": True, "provider": "custom", "tracer": Tracer()}, broken_callback
    )
    with pytest.raises(ValueError, match="application"):
        await observer.run("test", {}, work)
    assert count == 1


async def test_disabled_telemetry_and_callback_without_tracing():
    events = []
    observer = OperationObserver(
        {"enabled": False, "provider": "invalid"}, lambda e, details: events.append(details)
    )

    async def fail():
        raise ValueError("expected")

    with pytest.raises(ValueError):
        await observer.run("operation", {}, fail)
    assert events == [{"operation": "operation"}]
    with pytest.raises(ValueError, match="requires a tracer"):
        OperationObserver({"enabled": True, "provider": "custom"})
