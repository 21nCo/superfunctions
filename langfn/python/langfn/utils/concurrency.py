from __future__ import annotations

import asyncio
from typing import Any, Awaitable, List, Sequence, Union


async def gather_with_concurrency(
    limit: int, awaitables: Sequence[Awaitable[Any]]
) -> List[Union[Any, Exception]]:
    semaphore = asyncio.Semaphore(limit)

    async def _run(a: Awaitable[Any]):
        async with semaphore:
            try:
                return await a
            except Exception as exc:  # noqa: BLE001
                return exc

    return await asyncio.gather(*[_run(a) for a in awaitables])

