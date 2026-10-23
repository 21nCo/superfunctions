"""Tests for metric aggregator."""

import pytest
import time
from watchfn.core.metric_aggregator import MetricAggregator, MetricPoint


@pytest.fixture
def aggregator():
    return MetricAggregator(
        intervals=["1m", "5m"],
        window_size=1000
    )


class TestMetricAggregator:
    def test_add_metric_point(self, aggregator):
        """Test adding a metric point."""
        point = MetricPoint(
            timestamp=time.time() * 1000,
            value=100.0
        )
        
        aggregator.add("test.metric", point)
        
        results = aggregator.get(
            "test.metric",
            "1m",
            point.timestamp - 1000,
            point.timestamp + 1000
        )
        
        assert len(results) > 0
    
    def test_multiple_data_points(self, aggregator):
        """Test handling multiple data points."""
        now = time.time() * 1000
        
        for i in range(10):
            aggregator.add("test.metric", MetricPoint(
                timestamp=now + i * 1000,
                value=float(i * 10)
            ))
        
        results = aggregator.get(
            "test.metric",
            "1m",
            now - 1000,
            now + 11000
        )
        
        assert len(results) > 0
    
    def test_aggregation_functions(self, aggregator):
        """Test different aggregation functions."""
        now = time.time() * 1000
        values = [10.0, 20.0, 30.0, 40.0, 50.0]
        
        for i, value in enumerate(values):
            aggregator.add("test.metric", MetricPoint(
                timestamp=now + i * 1000,
                value=value
            ))
        
        avg_results = aggregator.get(
            "test.metric",
            "1m",
            now - 1000,
            now + 6000,
            function="avg"
        )
        
        assert len(avg_results) > 0
        # Average should be 30
        assert abs(avg_results[0].value - 30.0) < 1.0
    
    def test_percentile_calculation(self, aggregator):
        """Test percentile calculation."""
        now = time.time() * 1000
        
        # Add 100 values
        for i in range(1, 101):
            aggregator.add("test.metric", MetricPoint(
                timestamp=now + i * 100,
                value=float(i)
            ))
        
        p95_results = aggregator.get(
            "test.metric",
            "1m",
            now,
            now + 11000,
            function="p95"
        )
        
        assert len(p95_results) > 0
        p95_value = p95_results[0].value
        assert p95_value > 90
        assert p95_value <= 100
    
    def test_pruning(self, aggregator):
        """Test pruning old data."""
        old_timestamp = time.time() * 1000 - 10 * 60 * 1000  # 10 minutes ago
        
        aggregator.add("test.metric", MetricPoint(
            timestamp=old_timestamp,
            value=100.0
        ))
        
        # Prune data older than 5 minutes
        aggregator.prune(5 * 60 * 1000)
        
        results = aggregator.get(
            "test.metric",
            "1m",
            old_timestamp - 1000,
            old_timestamp + 1000
        )
        
        assert len(results) == 0
