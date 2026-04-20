"""Retry middleware for handling request retries."""

import asyncio
from typing import Callable, Awaitable, TypeVar, Optional, Dict, Any

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import RetryConfig

T = TypeVar('T')


class RetryMiddleware:
    """Middleware for executing functions with retry logic."""

    def __init__(self, config: RetryConfig):
        self.config = config

    async def execute(
        self,
        fn: Callable[[], Awaitable[T]],
        context: Optional[Dict[str, Any]] = None
    ) -> T:
        """Execute a coroutine function with retry semantics."""
        if not self.config.enabled:
            return await fn()

        last_error: Optional[Exception] = None
        max_attempts = self.config.max_attempts

        for attempt in range(1, max_attempts + 1):
            try:
                return await fn()
            except Exception as error:
                last_error = error

                if not self._is_retryable(error):
                    raise error

                if attempt == max_attempts:
                    break

                delay = self._calculate_delay(attempt)
                await asyncio.sleep(delay / 1000)  # Convert ms to seconds

        raise self._finalize_error(last_error, context)

    def _is_retryable(self, error: Exception) -> bool:
        if not self.config.retry_on:
            return True

        error_code = self._retry_code(error)
        if error_code is None:
            return False

        return error_code in self.config.retry_on

    def _retry_code(self, error: Exception) -> Optional[int]:
        status_code = getattr(error, "status_code", None)
        if isinstance(status_code, int):
            return status_code

        code = getattr(error, "code", None)
        if isinstance(code, int):
            return code

        return None

    def _finalize_error(
        self,
        error: Optional[Exception],
        context: Optional[Dict[str, Any]] = None,
    ) -> Exception:
        if error is None:
            return BrowseFnError("INTERNAL_ERROR", "Max retry attempts reached.")

        if self._retry_code(error) == 504:
            provider = context.get("provider") if context else None
            subject = provider or "upstream"
            return BrowseFnError(
                "UPSTREAM_TIMEOUT",
                f"Provider {subject} timed out after configured retries.",
                provider=provider,
            )

        return error

    def _calculate_delay(self, attempt: int) -> float:
        """Calculate delay based on the configured backoff strategy."""
        base_delay = self.config.delay

        if self.config.backoff == 'exponential':
            return base_delay * (2 ** (attempt - 1))

        return base_delay * attempt
