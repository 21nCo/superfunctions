from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Generic, Iterable, List, Sequence, TypeVar

from ..core.errors import InternalError, ValidationError
from .parallel import run_parallel_ordered

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
    def parallel(steps: Sequence[Step], *, concurrency: int | None = None) -> "Chain[Any, List[Any]]":
        async def _run(value: Any) -> List[Any]:
            return await run_parallel_ordered([lambda _=value, step=step: step(value) for step in steps], concurrency=concurrency)

        return Chain(_run=_run)

    @staticmethod
    def map_reduce(
        *,
        map: Callable[[Any], Awaitable[Any]],
        reduce: Callable[[List[Any]], Awaitable[Any]],
        concurrency: int | None = None,
    ) -> "Chain[Iterable[Any], Any]":
        async def _run(values: Iterable[Any]) -> Any:
            ordered_values = list(values)
            mapped = await run_parallel_ordered(
                [lambda value=value: map(value) for value in ordered_values],
                concurrency=concurrency,
            )
            return await reduce(mapped)

        return Chain(_run=_run)

    @staticmethod
    def router(
        *,
        routes: Dict[str, Callable[[Any], Awaitable[Any]]],
        router: Callable[[Any], Awaitable[str]],
    ) -> "Chain[Any, Any]":
        async def _run(value: Any) -> Any:
            try:
                key = await router(value)
            except Exception as exc:  # noqa: BLE001
                raise InternalError("Router failed to select a route") from exc
            handler = routes.get(key)
            if handler is None:
                raise ValidationError(f"Unknown route: {key}", metadata={"route": key})
            return await handler(value)

        return Chain(_run=_run)
