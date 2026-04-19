"""Tests for middleware and BrowseFn instrumentation."""

from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from browsefn.core.browse_fn import BrowseFn
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import BrowseFnConfig, CacheConfig, RetryConfig
from browsefn.middleware.logging import Logger
from browsefn.middleware.metrics import MetricsCollector
from browsefn.middleware.retry import RetryMiddleware


class UpstreamError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


@pytest.mark.asyncio
async def test_retry_middleware_success():
    retry = RetryMiddleware(RetryConfig(enabled=True, max_attempts=3, delay=10, backoff="linear"))

    async def successful_fn():
        return "success"

    assert await retry.execute(successful_fn) == "success"


@pytest.mark.asyncio
async def test_retry_middleware_eventual_success():
    retry = RetryMiddleware(RetryConfig(enabled=True, max_attempts=3, delay=10, backoff="linear"))
    attempts = []

    async def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise UpstreamError(504, "Temporary failure")
        return "success"

    assert await retry.execute(flaky) == "success"
    assert len(attempts) == 3


@pytest.mark.asyncio
async def test_retry_middleware_raises_structured_timeout_after_exhaustion():
    retry = RetryMiddleware(
        RetryConfig(enabled=True, max_attempts=2, delay=10, backoff="linear", retry_on=[504])
    )

    async def always_times_out():
        raise UpstreamError(504, "gateway timeout")

    with pytest.raises(BrowseFnError, match="Provider firecrawl timed out after configured retries."):
        await retry.execute(always_times_out, {"provider": "firecrawl"})


@pytest.mark.asyncio
async def test_retry_middleware_does_not_retry_non_retryable_status_codes():
    retry = RetryMiddleware(
        RetryConfig(enabled=True, max_attempts=3, delay=10, backoff="linear", retry_on=[504])
    )
    attempts = []

    async def forbidden():
        attempts.append(1)
        raise UpstreamError(403, "forbidden")

    with pytest.raises(UpstreamError, match="forbidden"):
        await retry.execute(forbidden)

    assert len(attempts) == 1


def test_logger_redacts_sensitive_context():
    logger = Logger()
    logger.info(
        "request",
        {
            "url": "https://api.unsplash.com/search?client_id=SECRET",
            "headers": {"Authorization": "Bearer SECRET"},
            "cookies": {"session": "SECRET"},
        },
    )

    log = logger.get_logs()[0]
    assert "SECRET" not in str(log.context)
    assert "[REDACTED]" in str(log.context)


def test_metrics_collector_aggregates_by_provider():
    collector = MetricsCollector()
    collector.record_request("p1", 100, True)
    collector.record_request("p1", 200, True)
    collector.record_request("p2", 300, False)

    metrics = collector.get_metrics({"groupBy": "provider"})

    assert metrics.totalRequests == 3
    assert metrics.successRate == pytest.approx(66.67, rel=0.01)
    assert metrics.avgResponseTime == 200
    assert [provider.name for provider in metrics.byProvider] == ["p1", "p2"]


@pytest.mark.asyncio
async def test_browsefn_records_cache_metrics_logs_and_events():
    browsefn = BrowseFn(
        BrowseFnConfig(
            cache=CacheConfig(enabled=True, ttl=60000),
            retry=RetryConfig(enabled=True, max_attempts=2, delay=1, backoff="linear"),
        )
    )
    events = []
    browsefn.on("request", lambda event: events.append("request"))
    browsefn.on("cache.hit", lambda event: events.append("cache.hit"))
    browsefn.on("response", lambda event: events.append("response"))

    async def payload():
        return {"provider": "unsplash", "ok": True}

    first = await browsefn._execute_operation(
        operation="images.search",
        provider="unsplash",
        cache_enabled=True,
        cache_method="GET",
        cache_url="https://api.unsplash.com/search?client_id=SECRET",
        cache_options={"provider": "unsplash"},
        fn=payload,
    )
    second = await browsefn._execute_operation(
        operation="images.search",
        provider="unsplash",
        cache_enabled=True,
        cache_method="GET",
        cache_url="https://api.unsplash.com/search?client_id=SECRET",
        cache_options={"provider": "unsplash"},
        fn=payload,
    )

    metrics = await browsefn.get_metrics()
    logs = browsefn.get_logs()

    assert first == second == {"provider": "unsplash", "ok": True}
    assert events == ["request", "response", "request", "cache.hit", "response"]
    assert metrics.totalRequests == 2
    assert metrics.cacheHitRate == 50.0
    assert all("SECRET" not in str(log.context) for log in logs)
