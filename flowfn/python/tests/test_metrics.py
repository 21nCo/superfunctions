"""Metrics reflect committed operations and durable state without invented zeroes."""

import asyncio

import pytest

from flowfn import create_flow
from flowfn.core.metrics import MetricsManager
from flowfn.adapters.memory import MemoryAdapter
from flowfn.queue.types import JobOptions
from flowfn.stream.types import ConsumerOptions
from flowfn.workflow.types import WorkflowExecution, ExecutionStatus
from tests.test_durable_adapters import adapters  # noqa: F401


async def test_queue_metrics_record_committed_completion_even_with_retention(monkeypatch):
    flow = create_flow()
    queue = flow.queue("measured")
    now = [1000]
    monkeypatch.setattr(queue, "_now", lambda: now[0])
    monkeypatch.setattr(flow.metrics, "_now", lambda: now[0])
    job = await queue.add("one", {}, JobOptions(remove_on_complete=True))
    claim = await flow._adapter.dequeue(queue.name)

    async def handler(job):
        now[0] += 25

    await queue._process_job(claim, handler)
    assert await queue.get_job(job.id) is None
    result = await flow.metrics.get_queue_metrics(queue.name)
    assert result["throughput"] == 1
    assert result["avg_duration"] == result["p95_duration"] == 25
    now[0] += 61000
    assert (await flow.metrics.get_queue_metrics(queue.name))["throughput"] == 0
    await flow.close()


async def test_high_rate_counter_and_detached_series(monkeypatch):
    metrics = MetricsManager(MemoryAdapter())
    monkeypatch.setattr(metrics, "_now", lambda: 1000)
    for _ in range(12000):
        metrics.increment("queue.throughput", {"queue": "many"})
    assert (await metrics.get_queue_metrics("many"))["throughput"] == 12000
    tags = {"a": "b,c:d"}
    metrics.record("latency", 10, tags)
    tags["a"] = "changed"
    metrics.record("latency", 20, {"a": "b,c:d"})
    result = metrics.get_time_series("latency", {"a": "b,c:d"}, since=0)
    assert result.p95 == 20
    result.data_points[0].value = 999
    assert metrics.get_time_series("latency", {"a": "b,c:d"}).min == 10
    assert metrics.get_time_series("latency", {"a": "b", "c": "d"}) is None
    assert metrics.get_time_series("latency", {"a": "b,c:d"}, limit=0) is None
    with pytest.raises(ValueError):
        metrics.get_time_series("latency", limit=-1)


async def check_workflow_metrics(adapter):
    for identity, status, end in [
        ("done", ExecutionStatus.COMPLETED, 200),
        ("failed", ExecutionStatus.FAILED, 400),
        ("running", ExecutionStatus.RUNNING, None),
    ]:
        await adapter.save_workflow_state(
            identity,
            WorkflowExecution(
                id=identity,
                workflow_id="metrics",
                input={},
                status=status,
                started_at=100,
                created_at=100,
                updated_at=100,
                completed_at=end,
            ),
        )
    result = await MetricsManager(adapter).get_workflow_metrics("metrics")
    assert result["total_executions"] == 3
    assert result["running"] == result["completed"] == result["failed"] == 1
    assert result["avg_duration"] == 200
    assert result["success_rate"] == pytest.approx(100 / 3)


async def test_persisted_workflow_metrics(adapters):
    a, b = adapters
    await check_workflow_metrics(a)
    assert (await MetricsManager(b).get_workflow_metrics("metrics"))["total_executions"] == 3


async def test_memory_workflow_metrics():
    await check_workflow_metrics(MemoryAdapter())


async def check_stream_metrics(adapter):
    # Metrics acceptance is separate from the one-second lease stress cases.
    if hasattr(adapter, "reclaim_after_ms"):
        adapter.reclaim_after_ms = 5000
    flow = create_flow(adapter)
    stream = flow.stream("lag")
    captured = []
    received = asyncio.Event()

    async def handler(message):
        captured.append(message)
        received.set()

    consumer = stream.create_consumer("reader", ConsumerOptions(group_id="group", max_in_flight=1))
    await consumer.subscribe(handler)
    await stream.publish("one")
    await stream.publish("two")
    await asyncio.wait_for(received.wait(), 5)
    result = await flow.metrics.get_stream_metrics(stream.name)
    assert result["lag"] == 2
    assert result["messages"] == 2
    assert result["avg_latency"] >= 0
    received.clear()
    await captured[0].ack()
    await asyncio.wait_for(received.wait(), 5)
    assert (await flow.metrics.get_stream_metrics(stream.name))["lag"] == 1
    assert (await flow.metrics.get_system_metrics())["streams"] == 1
    await flow.close()


async def test_stream_metrics(adapters):
    await check_stream_metrics(adapters[0])


async def test_memory_stream_metrics():
    await check_stream_metrics(MemoryAdapter())


async def test_rejected_completion_does_not_count_as_success(monkeypatch):
    flow = create_flow()
    queue = flow.queue("fenced")
    await queue.add("job", {})
    job = await flow._adapter.dequeue(queue.name)

    async def reject(*args):
        raise RuntimeError("storage rejected completion")

    monkeypatch.setattr(flow._adapter, "update_job", reject)

    async def handler(job):
        return "done"

    with pytest.raises(RuntimeError, match="storage rejected"):
        await queue._process_job(job, handler)
    result = await flow.metrics.get_queue_metrics(queue.name)
    assert result["throughput"] == 0
    assert result["avg_duration"] is None
    await flow.close()
