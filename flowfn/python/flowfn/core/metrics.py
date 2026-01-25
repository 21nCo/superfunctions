"""Metrics manager implementation."""

from typing import Any, Optional
from dataclasses import dataclass, field


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
    
    def __init__(self, adapter: Any):
        self.adapter = adapter
        self._metrics: dict[str, list[MetricDataPoint]] = {}
        self._max_data_points = 1000
    
    def record(
        self,
        name: str,
        value: float,
        tags: Optional[dict[str, str]] = None
    ) -> None:
        """Record a metric data point."""
        key = self._get_metric_key(name, tags)
        
        if key not in self._metrics:
            self._metrics[key] = []
        
        data_points = self._metrics[key]
        data_points.append(MetricDataPoint(
            timestamp=self._now(),
            value=value,
            tags=tags
        ))
        
        # Trim if exceeds max
        if len(data_points) > self._max_data_points:
            self._metrics[key] = data_points[-self._max_data_points:]
    
    def get_time_series(
        self,
        name: str,
        tags: Optional[dict[str, str]] = None,
        since: Optional[int] = None,
        limit: Optional[int] = None
    ) -> Optional[TimeSeriesMetrics]:
        """Get time series for a metric."""
        key = self._get_metric_key(name, tags)
        data_points = self._metrics.get(key, [])
        
        if since:
            data_points = [dp for dp in data_points if dp.timestamp >= since]
        
        if limit:
            data_points = data_points[-limit:]
        
        if not data_points:
            return None
        
        return self._calculate_aggregations(data_points)
    
    def _calculate_aggregations(
        self,
        data_points: list[MetricDataPoint]
    ) -> TimeSeriesMetrics:
        """Calculate aggregations for data points."""
        values = sorted([dp.value for dp in data_points])
        total = sum(values)
        count = len(values)
        
        return TimeSeriesMetrics(
            data_points=data_points,
            min=values[0],
            max=values[-1],
            avg=total / count,
            sum=total,
            count=count,
            p50=self._percentile(values, 50),
            p95=self._percentile(values, 95),
            p99=self._percentile(values, 99)
        )
    
    def _percentile(self, sorted_values: list[float], p: int) -> float:
        """Calculate percentile."""
        index = max(0, int((len(sorted_values) * p) / 100) - 1)
        return sorted_values[index]
    
    def _get_metric_key(
        self,
        name: str,
        tags: Optional[dict[str, str]]
    ) -> str:
        """Generate metric key with tags."""
        if not tags:
            return name
        
        tag_str = ','.join(
            f"{k}:{v}"
            for k, v in sorted(tags.items())
        )
        return f"{name}{{{tag_str}}}"
    
    def _now(self) -> int:
        """Get current timestamp."""
        import time
        return int(time.time() * 1000)
    
    async def get_queue_metrics(self, name: str) -> dict[str, Any]:
        """Get queue-specific metrics."""
        stats = await self.adapter.get_queue_stats(name)
        return {
            **stats.dict(),
            "throughput": 0,
            "avg_duration": 0,
            "p95_duration": 0
        }
    
    async def get_stream_metrics(self, name: str) -> dict[str, Any]:
        """Get stream-specific metrics."""
        info = await self.adapter.get_stream_info(name)
        return {
            **info.dict(),
            "lag": 0,
            "throughput": 0,
            "avg_latency": 0
        }
    
    async def get_workflow_metrics(self, name: str) -> dict[str, Any]:
        """Get workflow-specific metrics."""
        return {
            "total_executions": 0,
            "running": 0,
            "completed": 0,
            "failed": 0,
            "success_rate": 0,
            "avg_duration": 0
        }
