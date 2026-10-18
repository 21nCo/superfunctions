"""Bound cooperative delivery work by its renewable storage ownership."""
import asyncio
import time
from typing import Awaitable, Callable


async def run_with_lease(work: Callable[[], Awaitable[None]], renew: Callable[[], Awaitable[bool]],
                         lease_ms: int, started: float) -> None:
    duration = lease_ms / 1000
    if time.monotonic() >= started + duration:
        raise RuntimeError('Stream delivery lease expired before its claim reply')

    async def monitor() -> None:
        deadline = started + duration
        delay = duration / 3
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Stream delivery lease expired')
            await asyncio.sleep(min(delay, remaining))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Stream delivery lease expired')
            requested = time.monotonic()
            try:
                owned = await asyncio.wait_for(renew(), remaining)
            except Exception:
                delay = min(.05, duration / 6)
                continue
            if not owned:
                raise RuntimeError('Stream delivery ownership changed')
            deadline = requested + duration
            delay = duration / 3

    async def execute() -> None:
        await work()

    processing = asyncio.create_task(execute())
    heartbeat = asyncio.create_task(monitor())
    try:
        done, _ = await asyncio.wait((processing, heartbeat), return_when=asyncio.FIRST_COMPLETED)
        if processing in done:
            await processing
        else:
            await heartbeat
    finally:
        processing.cancel()
        heartbeat.cancel()
        await asyncio.gather(processing, heartbeat, return_exceptions=True)
