"""Rate limiting using token bucket algorithm."""

import time
from typing import Callable, Dict, Optional

from ..storage.file_storage import FileStorage
from ..types import (
    RateLimitEntry,
    RateLimitExceededError,
    RateLimitResult,
    RateLimitRule,
    RateLimitViolation,
)
from ..utils.helpers import generate_id


class RateLimiterConfig:
    """Configuration for rate limiter."""

    def __init__(
        self,
        storage: FileStorage,
        rules: Dict[str, RateLimitRule],
        on_limit_exceeded: Optional[Callable[[RateLimitViolation], None]] = None,
    ):
        """Initialize rate limiter config.
        
        Args:
            storage: Storage backend
            rules: Rate limit rules (global, perUser, perIP, perEndpoint)
            on_limit_exceeded: Callback for violations
        """
        self.storage = storage
        self.rules = rules
        self.on_limit_exceeded = on_limit_exceeded


class RateLimiter:
    """Token bucket rate limiter with multiple rule types."""

    def __init__(self, config: RateLimiterConfig):
        """Initialize rate limiter.
        
        Args:
            config: Rate limiter configuration
        """
        self.storage = config.storage
        self.rules = config.rules
        self.on_limit_exceeded = config.on_limit_exceeded

    async def check(
        self,
        user_id: Optional[str] = None,
        ip: str = "",
        endpoint: str = "",
    ) -> RateLimitResult:
        """Check rate limits for a request.
        
        Args:
            user_id: User ID (for per-user limits)
            ip: IP address (for per-IP limits)
            endpoint: Endpoint path (for per-endpoint limits)
            
        Returns:
            Rate limit result
            
        Raises:
            RateLimitExceededError: If rate limit exceeded and blocked
        """
        now = int(time.time() * 1000)

        # Check global limit
        if "global" in self.rules:
            result = await self._check_rule("global", self.rules["global"], now)
            if not result.allowed:
                await self._handle_violation("global", ip, user_id, endpoint, result)
                raise RateLimitExceededError(
                    f"Rate limit exceeded. Retry after {result.retry_after}ms"
                )

        # Check per-user limit
        if user_id and "perUser" in self.rules:
            key = f"user:{user_id}"
            result = await self._check_rule(key, self.rules["perUser"], now)
            if not result.allowed:
                await self._handle_violation(key, ip, user_id, endpoint, result)
                raise RateLimitExceededError(
                    f"Rate limit exceeded. Retry after {result.retry_after}ms"
                )

        # Check per-IP limit
        if ip and "perIP" in self.rules:
            key = f"ip:{ip}"
            result = await self._check_rule(key, self.rules["perIP"], now)
            if not result.allowed:
                await self._handle_violation(key, ip, user_id, endpoint, result)
                raise RateLimitExceededError(
                    f"Rate limit exceeded. Retry after {result.retry_after}ms"
                )

        # Check per-endpoint limit
        if endpoint and "perEndpoint" in self.rules:
            endpoint_rules = self.rules["perEndpoint"]
            if endpoint in endpoint_rules:
                key = f"endpoint:{endpoint}"
                result = await self._check_rule(key, endpoint_rules[endpoint], now)
                if not result.allowed:
                    await self._handle_violation(key, ip, user_id, endpoint, result)
                    raise RateLimitExceededError(
                        f"Rate limit exceeded. Retry after {result.retry_after}ms"
                    )

        # Return success result (use most restrictive limit for headers)
        return RateLimitResult(
            allowed=True,
            remaining=999,  # Simplified
            resetAt=now + 60000,
        )

    async def _check_rule(
        self, key: str, rule: RateLimitRule, now: int
    ) -> RateLimitResult:
        """Check a specific rate limit rule.
        
        Args:
            key: Rate limit key
            rule: Rate limit rule
            now: Current timestamp
            
        Returns:
            Rate limit result
        """
        entry = await self.storage.get_rate_limit_entry(key)

        # No entry exists, create new one
        if not entry or now >= entry.reset_at:
            new_entry = RateLimitEntry(
                key=key,
                count=1,
                resetAt=now + rule.window,
                blocked=False,
            )
            await self.storage.save_rate_limit_entry(new_entry)
            return RateLimitResult(
                allowed=True,
                remaining=rule.requests - 1,
                resetAt=new_entry.reset_at,
            )

        # Check if blocked
        if entry.blocked and entry.blocked_until:
            if now < entry.blocked_until:
                return RateLimitResult(
                    allowed=False,
                    remaining=0,
                    resetAt=entry.reset_at,
                    retryAfter=entry.blocked_until - now,
                    limit=rule.requests,
                )

        # Check if limit exceeded
        if entry.count >= rule.requests:
            # Block if configured
            if rule.block_duration:
                entry.blocked = True
                entry.blocked_until = now + rule.block_duration
                await self.storage.save_rate_limit_entry(entry)

                return RateLimitResult(
                    allowed=False,
                    remaining=0,
                    resetAt=entry.reset_at,
                    retryAfter=rule.block_duration,
                    limit=rule.requests,
                )

            return RateLimitResult(
                allowed=False,
                remaining=0,
                resetAt=entry.reset_at,
                retryAfter=entry.reset_at - now,
                limit=rule.requests,
            )

        # Increment count
        entry.count += 1
        await self.storage.save_rate_limit_entry(entry)

        return RateLimitResult(
            allowed=True,
            remaining=rule.requests - entry.count,
            resetAt=entry.reset_at,
            limit=rule.requests,
        )

    async def _handle_violation(
        self,
        key: str,
        ip: str,
        user_id: Optional[str],
        endpoint: str,
        result: RateLimitResult,
    ) -> None:
        """Handle a rate limit violation.
        
        Args:
            key: Rate limit key
            ip: IP address
            user_id: User ID
            endpoint: Endpoint
            result: Rate limit result
        """
        violation = RateLimitViolation(
            id=generate_id("violation"),
            timestamp=int(time.time() * 1000),
            key=key,
            ip=ip,
            userId=user_id,
            endpoint=endpoint,
            requestCount=result.limit or 0,
            limit=result.limit or 0,
            window=0,  # Simplified
            blocked=True,
        )

        if self.on_limit_exceeded:
            self.on_limit_exceeded(violation)
