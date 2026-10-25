"""Keep provider cancellation cleanup owned across supported asyncio versions."""
import asyncio
from collections.abc import Awaitable
from typing import TypeVar

T = TypeVar('T')


async def wait_for_owned(awaitable: Awaitable[T], timeout: float) -> T:
    """Apply a deadline without abandoning the underlying provider task.

    Python 3.9 wait_for may propagate outer cancellation before the cancelled
    provider finishes. Independent lease timers still fence expired work while
    this owner joins that cleanup. Repeated cancellation cannot detach it.
    """
    pending = asyncio.ensure_future(awaitable)
    try:
        return await asyncio.wait_for(pending, timeout)
    except BaseException as original:
        while not pending.done():
            try:
                await asyncio.shield(pending)
            except asyncio.CancelledError:
                # Preserve the original cancellation after provider termination.
                continue
            except BaseException:
                # Read the terminal exception below, retaining it as the cause.
                break
        if not pending.cancelled():
            provider_error = pending.exception()
            if provider_error is not None and provider_error is not original:
                raise original from provider_error
        raise
