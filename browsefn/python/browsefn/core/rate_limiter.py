"""Rate limiter implementation for BrowseFn requests."""

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Optional, Tuple

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import RateLimitConfig, RateLimitStatus


@dataclass
class RateLimitEntry:
    count: int = 0
    window_start: float = 0.0


class RateLimiter:
    """Deterministic global and per-provider sliding-window rate limiter."""

    GLOBAL_KEY = "__global__"

    def __init__(
        self,
        global_config: Optional[RateLimitConfig] = None,
        per_provider_configs: Optional[Dict[str, RateLimitConfig]] = None,
    ):
        self.global_config = global_config
        self.configs: Dict[str, RateLimitConfig] = per_provider_configs or {}
        self.limits: Dict[str, RateLimitEntry] = {}

    def _now_ms(self) -> float:
        return datetime.now().timestamp() * 1000

    def _get_entry(self, key: str, config: RateLimitConfig, now: float) -> RateLimitEntry:
        entry = self.limits.get(key)
        if entry is None:
            entry = RateLimitEntry(window_start=now)
            self.limits[key] = entry
            return entry

        if now - entry.window_start >= config.window:
            entry.count = 0
            entry.window_start = now

        return entry

    def _remaining(self, key: str, config: RateLimitConfig, now: float) -> int:
        entry = self._get_entry(key, config, now)
        return max(0, config.requests - entry.count)

    def _window_end(self, key: str, config: RateLimitConfig, now: float) -> float:
        entry = self._get_entry(key, config, now)
        return entry.window_start + config.window

    async def check_limit(self, provider: str) -> bool:
        """Consume one request if both global and provider windows allow it."""
        now = self._now_ms()

        checks: list[Tuple[str, RateLimitConfig]] = []
        if self.global_config:
            checks.append((self.GLOBAL_KEY, self.global_config))

        provider_config = self.configs.get(provider)
        if provider_config:
            checks.append((provider, provider_config))

        if not checks:
            return True

        if any(self._remaining(key, config, now) <= 0 for key, config in checks):
            return False

        for key, config in checks:
            entry = self._get_entry(key, config, now)
            entry.count += 1

        return True

    async def enforce(self, provider: str) -> None:
        """Raise a canonical error when a request would exceed the limit."""
        if await self.check_limit(provider):
            return

        status = self.get_status(provider)
        retry_after_ms = max(0, int(status.reset_at - self._now_ms()))
        raise BrowseFnError(
            "RATE_LIMITED",
            f"Rate limit exceeded for provider {provider}.",
            provider=provider,
            retry_after_ms=retry_after_ms,
        )

    async def wait_for_limit(self, provider: str) -> None:
        """Wait until both the global and provider windows allow the request."""
        while True:
            if await self.check_limit(provider):
                return

            status = self.get_status(provider)
            wait_time = max(0.0, status.reset_at - self._now_ms())
            await asyncio.sleep(min(wait_time / 1000, 0.05))

    def get_status(self, provider: str) -> RateLimitStatus:
        """Get the effective status for a provider across global and local limits."""
        now = self._now_ms()
        checks: list[Tuple[str, RateLimitConfig]] = []
        if self.global_config:
            checks.append((self.GLOBAL_KEY, self.global_config))

        provider_config = self.configs.get(provider)
        if provider_config:
            checks.append((provider, provider_config))

        if not checks:
            return RateLimitStatus(remaining=float("inf"), reset_at=0, limit=float("inf"))

        remaining_values = [self._remaining(key, config, now) for key, config in checks]
        reset_values = [self._window_end(key, config, now) for key, config in checks]
        limits = [config.requests for _, config in checks]

        return RateLimitStatus(
            remaining=min(remaining_values),
            reset_at=max(reset_values),
            limit=min(limits),
        )

    def reset(self, provider: Optional[str] = None) -> None:
        """Reset a provider limit or all limits."""
        if provider:
            self.limits.pop(provider, None)
            return

        self.limits.clear()

    def set_config(self, provider: str, config: RateLimitConfig) -> None:
        """Set or update a provider-specific rate limit."""
        self.configs[provider] = config
