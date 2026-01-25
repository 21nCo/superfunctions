"""Metric aggregation for real-time analytics."""

from typing import Dict, List, Optional, Literal
from dataclasses import dataclass
import time


AggregationInterval = Literal["1m", "5m", "15m", "1h", "6h", "1d"]
AggregationFunction = Literal["count", "sum", "avg", "min", "max", "p50", "p75", "p90", "p95", "p99"]


@dataclass
class MetricPoint:
    timestamp: float
    value: float
    tags: Optional[Dict[str, str]] = None


@dataclass
class AggregatedMetric:
    metric: str
    interval: str
    timestamp: float
    value: float
    function: str
    tags: Optional[Dict[str, str]] = None


class MetricAggregator:
    """Real-time metric aggregation with rolling windows."""
    
    def __init__(
        self,
        intervals: List[AggregationInterval] = None,
        functions: List[AggregationFunction] = None,
        window_size: int = 1000
    ):
        self.intervals = intervals or ["1m", "5m", "1h"]
        self.functions = functions or ["count", "avg", "p95"]
        self.window_size = window_size
        self.windows: Dict[str, Dict[str, List]] = {}  # metric -> {values, timestamps}
        self.aggregations: Dict[str, Dict[float, AggregatedMetric]] = {}
    
    def add(self, metric: str, point: MetricPoint) -> None:
        """Add a metric point and update rolling windows."""
        key = self._get_window_key(metric, point.tags)
        
        if key not in self.windows:
            self.windows[key] = {"values": [], "timestamps": []}
        
        window = self.windows[key]
        window["values"].append(point.value)
        window["timestamps"].append(point.timestamp)
        
        # Keep window size in check
        if len(window["values"]) > self.window_size:
            window["values"].pop(0)
            window["timestamps"].pop(0)
        
        # Trigger aggregation for configured intervals
        for interval in self.intervals:
            self._aggregate_window(metric, interval, point.timestamp, point.tags)
    
    def get(
        self,
        metric: str,
        interval: AggregationInterval,
        from_time: float,
        to_time: float,
        function: Optional[AggregationFunction] = None,
        tags: Optional[Dict[str, str]] = None
    ) -> List[AggregatedMetric]:
        """Get aggregated metrics for a time range."""
        key = self._get_aggregation_key(metric, interval, tags)
        aggs = self.aggregations.get(key, {})
        
        results = []
        for timestamp, agg in aggs.items():
            if from_time <= timestamp <= to_time:
                if function is None or agg.function == function:
                    results.append(agg)
        
        return sorted(results, key=lambda x: x.timestamp)
    
    def prune(self, retention_ms: float) -> None:
        """Clear old aggregations based on retention."""
        cutoff = time.time() * 1000 - retention_ms
        
        for key in list(self.aggregations.keys()):
            aggs = self.aggregations[key]
            to_delete = [ts for ts in aggs if ts < cutoff]
            for ts in to_delete:
                del aggs[ts]
            
            if not aggs:
                del self.aggregations[key]
        
        # Prune rolling windows
        for key in list(self.windows.keys()):
            window = self.windows[key]
            valid_indices = [i for i, ts in enumerate(window["timestamps"]) if ts >= cutoff]
            
            if not valid_indices:
                del self.windows[key]
            elif len(valid_indices) < len(window["timestamps"]):
                window["values"] = [window["values"][i] for i in valid_indices]
                window["timestamps"] = [window["timestamps"][i] for i in valid_indices]
    
    def _aggregate_window(
        self,
        metric: str,
        interval: AggregationInterval,
        timestamp: float,
        tags: Optional[Dict[str, str]] = None
    ) -> None:
        """Aggregate window for a specific interval."""
        interval_ms = self._get_interval_ms(interval)
        bucket_timestamp = (int(timestamp) // interval_ms) * interval_ms
        
        window_key = self._get_window_key(metric, tags)
        if window_key not in self.windows:
            return
        
        window = self.windows[window_key]
        if not window["values"]:
            return
        
        # Get values within this interval bucket
        bucket_values = [
            window["values"][i]
            for i, ts in enumerate(window["timestamps"])
            if bucket_timestamp <= ts < bucket_timestamp + interval_ms
        ]
        
        if not bucket_values:
            return
        
        # Calculate each aggregation function
        for func in self.functions:
            value = self._calculate_aggregation(bucket_values, func)
            agg_key = self._get_aggregation_key(metric, interval, tags)
            
            if agg_key not in self.aggregations:
                self.aggregations[agg_key] = {}
            
            self.aggregations[agg_key][bucket_timestamp] = AggregatedMetric(
                metric=metric,
                interval=interval,
                timestamp=bucket_timestamp,
                value=value,
                function=func,
                tags=tags
            )
    
    def _calculate_aggregation(self, values: List[float], func: AggregationFunction) -> float:
        """Calculate aggregation function."""
        if not values:
            return 0.0
        
        if func == "count":
            return float(len(values))
        elif func == "sum":
            return sum(values)
        elif func == "avg":
            return sum(values) / len(values)
        elif func == "min":
            return min(values)
        elif func == "max":
            return max(values)
        elif func in ["p50", "p75", "p90", "p95", "p99"]:
            p = int(func[1:])
            return self._percentile(values, p)
        return 0.0
    
    def _percentile(self, values: List[float], p: int) -> float:
        """Calculate percentile."""
        sorted_values = sorted(values)
        index = (p / 100) * (len(sorted_values) - 1)
        lower = int(index)
        upper = min(lower + 1, len(sorted_values) - 1)
        weight = index - lower
        
        if lower == upper:
            return sorted_values[lower]
        
        return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight
    
    def _get_interval_ms(self, interval: AggregationInterval) -> int:
        """Get interval duration in milliseconds."""
        intervals = {
            "1m": 60 * 1000,
            "5m": 5 * 60 * 1000,
            "15m": 15 * 60 * 1000,
            "1h": 60 * 60 * 1000,
            "6h": 6 * 60 * 60 * 1000,
            "1d": 24 * 60 * 60 * 1000,
        }
        return intervals[interval]
    
    def _get_window_key(self, metric: str, tags: Optional[Dict[str, str]]) -> str:
        """Get window key for metric and tags."""
        if tags:
            import json
            return f"{metric}:{json.dumps(tags, sort_keys=True)}"
        return metric
    
    def _get_aggregation_key(self, metric: str, interval: str, tags: Optional[Dict[str, str]]) -> str:
        """Get aggregation key."""
        if tags:
            import json
            return f"{metric}:{interval}:{json.dumps(tags, sort_keys=True)}"
        return f"{metric}:{interval}"
