"""Track admitted operations until their storage transitions finish."""
import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Callable


class Admissions:
    def __init__(self, closed: Callable[[], bool]) -> None:
        self.closed = closed
        self.pending: set[asyncio.Future[None]] = set()

    @asynccontextmanager
    async def track(self) -> AsyncIterator[None]:
        if self.closed():
            raise RuntimeError('Resource is closed')
        marker: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.pending.add(marker)
        try:
            yield
        finally:
            self.pending.discard(marker)
            marker.set_result(None)

    async def drain(self) -> None:
        if self.pending:
            await asyncio.gather(*(asyncio.shield(item) for item in list(self.pending)))
