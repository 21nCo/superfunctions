"""
Metrics collection middleware
"""

from typing import Dict, List, Optional, Literal
from datetime import datetime
from pydantic import BaseModel
from browsefn.core.types import Metrics, ProviderMetrics


TimeRange = Literal['last-hour', 'last-24h', 'last-7d', 'all']


class MetricEntry(BaseModel):
    """Single metric entry"""
    timestamp: float
    provider: str
    duration: float  # milliseconds
    success: bool


class MetricsCollector:
    """Collector for performance metrics"""
    
    def __init__(self):
        self.metrics: List[MetricEntry] = []
    
    def record_request(
        self,
        provider: str,
        duration: float,
        success: bool
    ) -> None:
        """Record a request metric"""
        entry = MetricEntry(
            timestamp=datetime.now().timestamp() * 1000,
            provider=provider,
            duration=duration,
            success=success
        )
        self.metrics.append(entry)
    
    def get_metrics(
        self,
        options: Optional[Dict[str, any]] = None
    ) -> Metrics:
        """Get aggregated metrics"""
        options = options or {}
        
        # Filter by time range
        filtered_metrics = self._filter_by_time_range(
            self.metrics,
            options.get('timeRange', 'all')
        )
        
        if not filtered_metrics:
            return Metrics(
                totalRequests=0,
                successRate=0.0,
                avgResponseTime=0.0,
                byProvider=[],
                cacheHitRate=None
            )
        
        # Calculate overall metrics
        total_requests = len(filtered_metrics)
        successes = sum(1 for m in filtered_metrics if m.success)
        success_rate = (successes / total_requests * 100) if total_requests > 0 else 0.0
        
        total_duration = sum(m.duration for m in filtered_metrics)
        avg_response_time = total_duration / total_requests if total_requests > 0 else 0.0
        
        # Calculate by provider if requested
        by_provider: List[ProviderMetrics] = []
        if options.get('groupBy') == 'provider':
            by_provider = self._calculate_by_provider(filtered_metrics)
        
        return Metrics(
            totalRequests=total_requests,
            successRate=success_rate,
            avgResponseTime=avg_response_time,
            byProvider=by_provider,
            cacheHitRate=None  # Set by BrowseFn main class
        )
    
    def _filter_by_time_range(
        self,
        metrics: List[MetricEntry],
        time_range: TimeRange
    ) -> List[MetricEntry]:
        """Filter metrics by time range"""
        if time_range == 'all':
            return metrics
        
        now = datetime.now().timestamp() * 1000
        
        # Calculate cutoff time
        cutoff_map = {
            'last-hour': 3600000,  # 1 hour in ms
            'last-24h': 86400000,  # 24 hours in ms
            'last-7d': 604800000   # 7 days in ms
        }
        
        cutoff_ms = cutoff_map.get(time_range, 0)
        cutoff_time = now - cutoff_ms
        
        return [m for m in metrics if m.timestamp >= cutoff_time]
    
    def _calculate_by_provider(
        self,
        metrics: List[MetricEntry]
    ) -> List[ProviderMetrics]:
        """Calculate metrics grouped by provider"""
        provider_data: Dict[str, List[MetricEntry]] = {}
        
        for metric in metrics:
            if metric.provider not in provider_data:
                provider_data[metric.provider] = []
            provider_data[metric.provider].append(metric)
        
        result: List[ProviderMetrics] = []
        
        for provider, provider_metrics in provider_data.items():
            total = len(provider_metrics)
            successes = sum(1 for m in provider_metrics if m.success)
            failures = total - successes
            
            total_duration = sum(m.duration for m in provider_metrics)
            avg_time = total_duration / total if total > 0 else 0.0
            
            result.append(ProviderMetrics(
                name=provider,
                requests=total,
                successes=successes,
                failures=failures,
                avgResponseTime=avg_time
            ))
        
        return result
    
    def clear(self) -> None:
        """Clear all metrics"""
        self.metrics.clear()
