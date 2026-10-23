"""W3C context survives durable storage and cannot inherit an unrelated worker span."""

import asyncio

import pytest

from flowfn import create_flow
from flowfn.adapters.memory import MemoryAdapter
from flowfn.core.telemetry import OperationObserver
from flowfn.stream.types import ConsumerOptions


def tracing():
    trace = pytest.importorskip("opentelemetry.trace")
    pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return trace, provider, exporter


async def check_propagation(a, b):
    trace, provider, exporter = tracing()
    options = {"enabled": True, "tracer_provider": provider}
    producer = create_flow(a, telemetry=options)
    worker = create_flow(b, telemetry=options)
    if hasattr(a, "reclaim_after_ms"):
        a.reclaim_after_ms = b.reclaim_after_ms = 5000
    try:

        async def step(context):
            assert trace.get_current_span().is_recording()

        workflow = producer.workflow("trace").step("one", step).build()
        with provider.get_tracer("application").start_as_current_span("producer") as parent:
            parent_context = parent.get_span_context()
            job = await producer.queue("trace").add("one", {})
            await producer.stream("trace").publish({})
            execution = await workflow.execute({})
        await asyncio.wait_for(workflow._tasks[execution.id], 10)
        stored = await b.load_workflow_state(execution.id)
        assert stored.trace_context["traceparent"].split("-")[1] == format(
            parent_context.trace_id, "032x"
        )
        queue = worker.queue("trace")
        claimed = await worker._adapter.dequeue(queue.name)
        assert claimed.trace_context == job.trace_context
        assert set(claimed.trace_context) <= {"traceparent", "tracestate"}

        async def handle(job):
            assert trace.get_current_span().get_span_context().trace_id == parent_context.trace_id

        received = asyncio.Event()

        async def message(message):
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
        assert all(span.parent.span_id == parent_context.span_id for span in observed)
    finally:
        await producer.close()
        await worker.close()
        provider.shutdown()


async def test_memory_trace_propagation():
    adapter = MemoryAdapter()
    await check_propagation(adapter, adapter)


async def test_native_trace_propagation(adapters):
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
async def test_invalid_or_missing_carrier_starts_root(carrier):
    trace, provider, exporter = tracing()
    observer = OperationObserver({"enabled": True, "tracer_provider": provider})

    async def work():
        return 7

    try:
        with provider.get_tracer("test").start_as_current_span("unrelated"):
            assert await observer.run("consumer", {}, work, carrier=carrier, consumer=True) == 7
        span = next(span for span in exporter.get_finished_spans() if span.name == "consumer")
        assert span.parent is None
    finally:
        provider.shutdown()


async def test_disabled_capture_and_baggage_omission():
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
