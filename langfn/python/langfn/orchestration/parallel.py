from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, List, Sequence


async def run_parallel_ordered(
    tasks: Sequence[Callable[[], Awaitable[Any]]],
    *,
    concurrency: int | None = None,
) -> List[Any]:
    limit = max(1, concurrency or len(tasks) or 1)
    semaphore = asyncio.Semaphore(limit)
    results: List[Any] = [None] * len(tasks)

    async def worker(index: int, task: Callable[[], Awaitable[Any]]) -> None:
        async with semaphore:
            results[index] = await task()

    await asyncio.gather(*(worker(index, task) for index, task in enumerate(tasks)))
    return results
