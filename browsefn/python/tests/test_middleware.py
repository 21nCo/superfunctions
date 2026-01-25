"""
Tests for middleware components
"""

import pytest
import asyncio
from browsefn.middleware.retry import RetryMiddleware
from browsefn.middleware.logging import Logger
from browsefn.middleware.metrics import MetricsCollector
from browsefn.core.types import RetryConfig


@pytest.mark.asyncio
async def test_retry_middleware_success():
    """Test retry middleware with successful execution"""
    config = RetryConfig(enabled=True, max_attempts=3, delay=10, backoff='linear')
    retry = RetryMiddleware(config)
    
    async def successful_fn():
        return 'success'
    
    result = await retry.execute(successful_fn)
    assert result == 'success'


@pytest.mark.asyncio
async def test_retry_middleware_eventual_success():
    """Test retry middleware with eventual success"""
    config = RetryConfig(enabled=True, max_attempts=3, delay=10, backoff='linear')
    retry = RetryMiddleware(config)
    
    attempts = []
    async def failing_then_success():
        attempts.append(1)
        if len(attempts) < 3:
            raise Exception('Temporary failure')
        return 'success'
    
    result = await retry.execute(failing_then_success)
    assert result == 'success'
    assert len(attempts) == 3


@pytest.mark.asyncio
async def test_retry_middleware_max_attempts():
    """Test retry middleware respects max attempts"""
    config = RetryConfig(enabled=True, max_attempts=2, delay=10, backoff='linear')
    retry = RetryMiddleware(config)
    
    attempts = []
    async def always_fails():
        attempts.append(1)
        raise Exception('Always fails')
    
    with pytest.raises(Exception, match='Always fails'):
        await retry.execute(always_fails)
    
    assert len(attempts) == 2


def test_logger_basic():
    """Test basic logging functionality"""
    logger = Logger()
    
   logger.info('Test message', {'key': 'value'})
    logger.error('Error message')
    
    logs = logger.get_logs()
    assert len(logs) == 2
    assert logs[0].level == 'info'
    assert logs[0].message == 'Test message'
    assert logs[0].context['key'] == 'value'


def test_logger_filtering():
    """Test log filtering"""
    logger = Logger()
    
    logger.info('Message 1', {'provider': 'test1'})
    logger.info('Message 2', {'provider': 'test2'})
    logger.error('Message 3', {'provider': 'test1'})
    
    filtered = logger.get_logs({'provider': 'test1'})
    assert len(filtered) == 2


def test_metrics_collector_basic():
    """Test basic metrics collection"""
    collector = MetricsCollector()
    
    collector.record_request('provider1', 100, True)
    collector.record_request('provider1', 200, True)
    collector.record_request('provider1', 150, False)
    
    metrics = collector.get_metrics()
    
    assert metrics.totalRequests == 3
    assert metrics.successRate == pytest.approx(66.67, rel=0.01)
    assert metrics.avgResponseTime == 150


def test_metrics_collector_by_provider():
    """Test metrics grouped by provider"""
    collector = MetricsCollector()
    
    collector.record_request('p1', 100, True)
    collector.record_request('p1', 200, True)
    collector.record_request('p2', 300, False)
    
    metrics = collector.get_metrics({'groupBy': 'provider'})
    
    assert len(metrics.byProvider) == 2
    provider_names = [p.name for p in metrics.byProvider]
    assert 'p1' in provider_names
    assert 'p2' in provider_names
