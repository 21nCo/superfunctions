from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, TypeVar, Union

from ..core.errors import LangFnError, RateLimitError, TimeoutError

T = TypeVar("T")


@dataclass(frozen=True)
class RetryConfig:
    max_attempts: int = 3
    base_delay_s: float = 0.25
    max_delay_s: float = 5.0

    retry_on_codes: frozenset[str] = frozenset({"RATE_LIMIT", "TIMEOUT"})


def _default_should_retry(err: Exception, cfg: RetryConfig) -> bool:
    if isinstance(err, LangFnError):
        return err.code in cfg.retry_on_codes
    return False


async def retry_async(
    fn: Callable[[], Awaitable[T]],
    *,
    config: RetryConfig,
    should_retry: Optional[Callable[[Exception], bool]] = None,
) -> T:
    attempts = 0
    should_retry = should_retry or (lambda e: _default_should_retry(e, config))

    while True:
        attempts += 1
        try:
            return await fn()
        except Exception as exc:  # noqa: BLE001
            if attempts >= config.max_attempts or not should_retry(exc):
                raise

            delay = min(config.max_delay_s, config.base_delay_s * (2 ** (attempts - 1)))
            delay = delay * (0.8 + 0.4 * random.random())

            if isinstance(exc, RateLimitError) and exc.retry_after is not None:
                delay = max(delay, float(exc.retry_after))

            await asyncio.sleep(delay)

