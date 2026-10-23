"""W3C context survives durable storage and cannot inherit an unrelated worker span."""

from __future__ import annotations

import asyncio
from types import ModuleType

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from flowfn import create_flow
from flowfn.adapters.base import FlowAdapter
from flowfn.adapters.memory import MemoryAdapter
from flowfn.adapters.postgres import PostgresAdapter
from flowfn.adapters.redis import RedisAdapter
from flowfn.core.telemetry import OperationObserver
from flowfn.queue.types import Job
from flowfn.stream.types import ConsumerOptions, Message
from flowfn.workflow.types import WorkflowContext
from tests.assertions import require_value
from tests.native_support import NativeAdapters


def tracing() -> tuple[ModuleType, TracerProvider, InMemorySpanExporter]:
    trace = pytest.importorskip("opentelemetry.trace")
    pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return trace, provider, exporter


async def check_propagation(a: FlowAdapter, b: FlowAdapter) -> None:
    trace, provider, exporter = tracing()
    options = {"enabled": True, "tracer_provider": provider}
    producer = create_flow(a, telemetry=options)
    worker = create_flow(b, telemetry=options)
    if isinstance(a, (RedisAdapter, PostgresAdapter)):
        assert isinstance(b, (RedisAdapter, PostgresAdapter))
        a.reclaim_after_ms = b.reclaim_after_ms = 5000
    try:

        async def step(context: WorkflowContext) -> None:
            assert trace.get_current_span().is_recording()

        workflow = producer.workflow("trace").step("one", step).build()
        with provider.get_tracer("application").start_as_current_span("producer") as parent:
            parent_context = parent.get_span_context()
            job = await producer.queue("trace").add("one", {})
            await producer.stream("trace").publish({})
            execution = await workflow.execute({})
        await asyncio.wait_for(workflow._tasks[execution.id], 10)
        stored = await b.load_workflow_state(execution.id)
        assert stored is not None
        assert require_value(stored.trace_context)["traceparent"].split("-")[1] == format(
            parent_context.trace_id, "032x"
        )
        queue = worker.queue("trace")
        claimed = await worker._adapter.dequeue(queue.name)
        assert claimed is not None
        assert claimed.trace_context == job.trace_context
        assert set(require_value(claimed.trace_context)) <= {"traceparent", "tracestate"}

        async def handle(job: Job) -> None:
            assert trace.get_current_span().get_span_context().trace_id == parent_context.trace_id

        received = asyncio.Event()

        async def message(message: Message) -> None:
            assert trace.get_current_span().get_span_context().trace_id == parent_context.trace_id
            await message.ack()
            received.set()

        with provider.get_tracer("application").start_as_current_span("unrelated-worker"):
            await queue._process_job(claimed, handle)
            consumer = worker.stream("trace").create_consumer(
                "reader", ConsumerOptions(group_id="g", max_in_flight=1, from_beginning=True)
            )
            await consumer.subscribe(message)
            await asyncio.wait_for(received.wait(), 10)
            await consumer.close()
        provider.force_flush()
        observed = [
            span
            for span in exporter.get_finished_spans()
            if span.name in ("flowfn.job.execute", "flowfn.workflow.step", "flowfn.stream.message")
        ]
        assert len(observed) == 3
        assert all(require_value(span.parent).span_id == parent_context.span_id for span in observed)
    finally:
        await producer.close()
        await worker.close()
        provider.shutdown()


async def test_memory_trace_propagation() -> None:
    adapter = MemoryAdapter()
    await check_propagation(adapter, adapter)


async def test_native_trace_propagation(adapters: NativeAdapters) -> None:
    await check_propagation(*adapters)


@pytest.mark.parametrize(
    "carrier",
    [
        None,
        {},
        {"traceparent": "invalid"},
        {"traceparent": "x" * 10000, "baggage": "secret"},
        {"traceparent": "00-" + "0" * 32 + "-0123456789abcdef-01"},
        {"traceparent": "00-0123456789abcdef0123456789abcdef-" + "0" * 16 + "-01"},
        {"tracestate": "vendor=value"},
    ],
)
async def test_invalid_or_missing_carrier_starts_root(carrier: dict[str, str] | None) -> None:
    trace, provider, exporter = tracing()
    observer = OperationObserver({"enabled": True, "tracer_provider": provider})

    async def work() -> int:
        return 7

    try:
        with provider.get_tracer("test").start_as_current_span("unrelated"):
            assert await observer.run("consumer", {}, work, carrier=carrier, consumer=True) == 7
        span = next(span for span in exporter.get_finished_spans() if span.name == "consumer")
        assert span.parent is None
    finally:
        provider.shutdown()


async def test_disabled_capture_and_baggage_omission() -> None:
    trace, provider, exporter = tracing()
    from opentelemetry import baggage, context

    observer = OperationObserver({"enabled": True, "tracer_provider": provider})
    try:
        with provider.get_tracer("test").start_as_current_span("parent"):
            token = context.attach(baggage.set_baggage("secret", "never-propagate"))
            try:
                assert set(observer.capture_context()) == {"traceparent"}
                assert OperationObserver().capture_context() == {}
            finally:
                context.detach(token)
    finally:
        provider.shutdown()
