"""Owned callbacks for PostgreSQL partition receipts."""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from flowfn.adapters.postgres import PostgresSubscription
from flowfn.adapters.stream_lease import run_with_lease
from flowfn.stream.types import Message


class PostgresPartitionSubscription(PostgresSubscription):
    async def _worker(self) -> None:
        assert self.options is not None and self.group is not None
        while not self.closed:
            await self.running.wait()
            try:
                started = time.monotonic()
                token = uuid.uuid4().hex
                row = await self.adapter._partitions.claim(self.stream, self.group, self.options.visibility_timeout, token)
                if row is None:
                    await asyncio.sleep(.02)
                    continue
                await self._deliver(row, token, started)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.error = error
                await asyncio.sleep(.1)

    async def _deliver(self, row: Any, token: str, started: float) -> None:
        assert self.options is not None and self.group is not None
        protocol = self.adapter._partitions
        stream, group, duration = self.stream, self.group, self.options.visibility_timeout
        identity = int(row['id'])
        decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        deadline = started + duration / 1000
        settled = False
        terminal = False

        async def settle(requeue: bool) -> None:
            nonlocal settled
            if terminal or decision.cancelled():
                raise RuntimeError('Stream delivery ownership changed')
            if decision.done():
                return
            if not await protocol.settle(stream, group, identity, token, requeue):
                raise RuntimeError('Stream delivery ownership changed')
            settled = True
            if not decision.done():
                decision.set_result(requeue)

        async def renew() -> bool:
            nonlocal deadline
            if settled:
                return True
            requested = time.monotonic()
            owned = await protocol.renew(stream, group, identity, token, duration)
            if owned:
                deadline = requested + duration / 1000
            return owned

        try:
            message = Message.model_validate_json(row['payload'])
            message._acknowledge = settle

            async def process() -> None:
                await self.running.wait()
                await self.handler(message)

            await run_with_lease(process, renew, duration, started)
            if self.options.auto_commit and not decision.done():
                await settle(False)
            if not decision.done():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError('Stream delivery lease expired')
                await asyncio.wait_for(asyncio.shield(decision), remaining)
        finally:
            terminal = True
            if not decision.done():
                decision.cancel()
            if not settled:
                await protocol.settle(stream, group, identity, token, True)
