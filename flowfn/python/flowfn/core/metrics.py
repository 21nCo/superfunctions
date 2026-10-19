"""Metrics manager implementation."""

import math
import json
from copy import deepcopy
from typing import Any, Optional, Callable
from dataclasses import dataclass


@dataclass
class MetricDataPoint:
    """Single metric data point."""

    timestamp: int
    value: float
    tags: Optional[dict[str, str]] = None


@dataclass
class TimeSeriesMetrics:
    """Time series metrics with aggregations."""

    data_points: list[MetricDataPoint]
    min: float
    max: float
    avg: float
    sum: float
    count: int
    p50: Optional[float] = None
    p95: Optional[float] = None
    p99: Optional[float] = None


class MetricsManager:
    """Metrics collection and aggregation."""

    def __init__(self, adapter: Any, inventory: Optional[Callable[[], dict[str, int]]] = None):
        self.adapter = adapter
        self._inventory = inventory
        self._metrics: dict[str, list[MetricDataPoint]] = {}
        self._max_data_points = 1000

    def record(self, name: str, value: float, tags: Optional[dict[str, str]] = None) -> None:
        """Record a metric data point."""
        if not math.isfinite(value):
            raise ValueError("Metric values must be finite")
        key = self._get_metric_key(name, tags)

        if key not in self._metrics:
            self._metrics[key] = []

        data_points = self._metrics[key]
        data_points.append(
            MetricDataPoint(timestamp=self._now(), value=value, tags=dict(tags) if tags else None)
        )

        # Trim if exceeds max
        if len(data_points) > self._max_data_points:
            self._metrics[key] = data_points[-self._max_data_points :]

    def get_time_series(
        self,
        name: str,
        tags: Optional[dict[str, str]] = None,
        since: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Optional[TimeSeriesMetrics]:
        """Get time series for a metric."""
        key = self._get_metric_key(name, tags)
        data_points = self._metrics.get(key, [])

        if since is not None:
            data_points = [dp for dp in data_points if dp.timestamp >= since]

        if limit is not None:
            if isinstance(limit, bool) or limit < 0:
                raise ValueError("Metric limit must be nonnegative")
            data_points = data_points[-limit:] if limit else []

        if not data_points:
            return None

        return self._calculate_aggregations(data_points)

    def _calculate_aggregations(self, data_points: list[MetricDataPoint]) -> TimeSeriesMetrics:
        """Calculate aggregations for data points."""
        values = sorted([dp.value for dp in data_points])
        total = sum(values)
        count = len(values)

        return TimeSeriesMetrics(
            data_points=deepcopy(data_points),
            min=values[0],
            max=values[-1],
            avg=total / count,
            sum=total,
            count=count,
            p50=self._percentile(values, 50),
            p95=self._percentile(values, 95),
            p99=self._percentile(values, 99),
        )

    def _percentile(self, sorted_values: list[float], p: int) -> float:
        """Calculate percentile."""
        index = max(0, math.ceil((len(sorted_values) * p) / 100) - 1)
        return sorted_values[index]

    def _get_metric_key(self, name: str, tags: Optional[dict[str, str]]) -> str:
        """Generate metric key with tags."""
        return json.dumps([name, sorted((tags or {}).items())], separators=(",", ":"))

    def _now(self) -> int:
        """Get current timestamp."""
        import time

        return int(time.time() * 1000)

    def increment(self, name: str, tags: Optional[dict[str, str]] = None) -> None:
        """Aggregate counters per second so high event rates retain a full window."""
        key = self._get_metric_key(name, tags)
        bucket = self._now() // 1000 * 1000
        points = self._metrics.setdefault(key, [])
        if points and points[-1].timestamp == bucket:
            points[-1].value += 1
        else:
            points.append(MetricDataPoint(bucket, 1, dict(tags) if tags else None))
            if len(points) > self._max_data_points:
                del points[: -self._max_data_points]

    async def get_queue_metrics(self, name: str) -> dict[str, Any]:
        stats = await self.adapter.get_queue_stats(name)
        throughput = self.get_time_series(
            "queue.throughput", {"queue": name}, since=(self._now() // 1000 - 59) * 1000
        )
        duration = self.get_time_series("queue.job.duration", {"queue": name})
        return {
            **stats.model_dump(),
            "throughput": throughput.sum if throughput else 0,
            "avg_duration": duration.avg if duration else None,
            "p95_duration": duration.p95 if duration else None,
        }

    async def get_stream_metrics(self, name: str) -> dict[str, Any]:
        info = await self.adapter.get_stream_info(name)
        throughput = self.get_time_series(
            "stream.throughput", {"stream": name}, since=self._now() // 1000 * 1000
        )
        latency = self.get_time_series("stream.latency", {"stream": name})
        return {
            **info.model_dump(),
            "messages": info.length,
            "throughput": throughput.sum if throughput else 0,
            "avg_latency": latency.avg if latency else None,
        }

    async def get_workflow_metrics(self, name: str) -> dict[str, Any]:
        executions = await self.adapter.list_workflow_states(name)
        completed = sum(item.status.value == "completed" for item in executions)
        finished = [item for item in executions if item.completed_at is not None]
        durations = [max(0, item.completed_at - item.started_at) for item in finished]
        return {
            "total_executions": len(executions),
            "running": sum(item.status.value == "running" for item in executions),
            "completed": completed,
            "failed": sum(item.status.value == "failed" for item in executions),
            "cancelled": sum(item.status.value == "cancelled" for item in executions),
            "success_rate": completed / len(executions) * 100 if executions else 0,
            "avg_duration": sum(durations) / len(durations) if durations else None,
        }

    async def get_system_metrics(self) -> dict[str, Any]:
        memory: Optional[int] = None
        try:
            import psutil

            memory = int(psutil.Process().memory_info().rss)
        except ImportError:
            pass
        return {**(self._inventory() if self._inventory else {}), "memory_usage": memory}
