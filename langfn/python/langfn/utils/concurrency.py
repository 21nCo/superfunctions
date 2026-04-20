from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, List, Sequence, TypeVar, Union


T = TypeVar("T")
TResult = TypeVar("TResult")


async def gather_with_concurrency(
    limit: int, awaitables: Sequence[Awaitable[Any]]
) -> List[Union[Any, Exception]]:
    if limit < 1:
        raise ValueError("limit must be >= 1")
    semaphore = asyncio.Semaphore(limit)

    async def _run(a: Awaitable[Any]):
        async with semaphore:
            try:
                return await a
            except Exception as exc:  # noqa: BLE001
                return exc

    return await asyncio.gather(*[_run(a) for a in awaitables])


async def map_with_concurrency(
    limit: int,
    values: Sequence[T],
    mapper: Callable[[T, int], Awaitable[TResult]],
) -> List[Union[TResult, Exception]]:
    return await gather_with_concurrency(
        limit,
        [mapper(value, index) for index, value in enumerate(values)],
    )
