from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Generic, Iterable, List, Optional, Sequence, TypeVar

TIn = TypeVar("TIn")
TOut = TypeVar("TOut")


Step = Callable[[Any], Awaitable[Any]]


@dataclass(frozen=True)
class Chain(Generic[TIn, TOut]):
    _run: Callable[[TIn], Awaitable[TOut]]

    async def run(self, value: TIn) -> TOut:
        return await self._run(value)

    @staticmethod
    def sequential(steps: Sequence[Step]) -> "Chain[Any, Any]":
        async def _run(value: Any) -> Any:
            current = value
            for step in steps:
                current = await step(current)
            return current

        return Chain(_run=_run)

    @staticmethod
    def parallel(steps: Sequence[Step]) -> "Chain[Any, List[Any]]":
        async def _run(value: Any) -> List[Any]:
            return await asyncio.gather(*[step(value) for step in steps])

        return Chain(_run=_run)

    @staticmethod
    def map_reduce(
        *,
        map: Callable[[Any], Awaitable[Any]],
        reduce: Callable[[List[Any]], Awaitable[Any]],
    ) -> "Chain[Iterable[Any], Any]":
        async def _run(values: Iterable[Any]) -> Any:
            mapped = await asyncio.gather(*[map(v) for v in values])
            return await reduce(list(mapped))

        return Chain(_run=_run)

    @staticmethod
    def router(
        *,
        routes: Dict[str, Callable[[Any], Awaitable[Any]]],
        router: Callable[[Any], Awaitable[str]],
    ) -> "Chain[Any, Any]":
        async def _run(value: Any) -> Any:
            key = await router(value)
            handler = routes.get(key)
            if handler is None:
                raise KeyError(f"Unknown route: {key}")
            return await handler(value)

        return Chain(_run=_run)

