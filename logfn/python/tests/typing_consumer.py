"""Run against an installed wheel to validate the public callable-sink contract."""
import asyncio

from logfn import LogEvent, Sink, create_logger


async def main() -> None:
    received: list[LogEvent] = []
    flushed: list[str] = []

    def synchronous(items: list[LogEvent], /) -> None:
        received.extend(items)

    async def asynchronous(items: list[LogEvent], /) -> None:
        await asyncio.sleep(0)
        received.extend(items)

    class SyncHook:
        def __call__(self, items: list[LogEvent], /) -> None:
            received.extend(items)

        def flush(self) -> None:
            flushed.append("sync")

    class AsyncHook:
        async def __call__(self, items: list[LogEvent], /) -> None:
            received.extend(items)

        async def flush(self) -> None:
            await asyncio.sleep(0)
            flushed.append("async")

    sinks: list[Sink] = [synchronous, asynchronous, received.extend, SyncHook(), AsyncHook()]
    assert all(isinstance(sink, Sink) for sink in sinks)
    logger = create_logger("wheel-consumer", sinks)
    logger.info("delivered")
    await logger.flush()
    assert len(received) == 5
    assert all(event["msg"] == "delivered" for event in received)
    assert sorted(flushed) == ["async", "sync"]


if __name__ == "__main__":
    asyncio.run(main())
