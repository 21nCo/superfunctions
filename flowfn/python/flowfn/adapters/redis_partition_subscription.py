"""Owned partition callbacks with token-fenced receipts and cooperative expiry."""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from flowfn.adapters.redis import RedisSubscription
from flowfn.adapters.redis_partitions import decode_message
from flowfn.adapters.stream_lease import run_with_lease


class RedisPartitionSubscription(RedisSubscription):
    async def _worker(self) -> None:
        assert self.options is not None and self.group is not None
        while not self.closed:
            await self.running.wait()
            try:
                started = time.monotonic()
                rows = await self.adapter._partitions.claim(
                    self.stream_name, self.group, self.options.visibility_timeout, uuid.uuid4().hex
                )
                if not rows:
                    await asyncio.sleep(0.02)
                    continue
                for identity, fields, token, partition in rows:
                    await self._deliver(identity, fields, token, partition, started)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.error = error
                await asyncio.sleep(0.1)

    async def _deliver(
        self, identity: str, fields: dict[str, Any], token: str, partition: str, started: float
    ) -> None:
        assert self.options is not None and self.group is not None
        protocol = self.adapter._partitions
        stream, group, duration = self.stream_name, self.group, self.options.visibility_timeout
        decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        deadline = started + duration / 1000
        settled = False
        terminal = False

        async def settle(requeue: bool) -> None:
            nonlocal settled
            if terminal or decision.cancelled():
                raise RuntimeError("Stream delivery ownership changed")
            if decision.done():
                return
            if not await protocol.settle(stream, group, partition, identity, token, requeue):
                raise RuntimeError("Stream delivery ownership changed")
            settled = True
            if not decision.done():
                decision.set_result(requeue)

        async def renew() -> bool:
            nonlocal deadline
            if settled:
                return True  # Explicit receipt releases ownership; callback still joins.
            requested = time.monotonic()
            owned = await protocol.renew(stream, group, partition, identity, token, duration)
            if owned:
                deadline = requested + duration / 1000
            return owned

        try:
            message = decode_message(stream, identity, fields)
            if str(message.partition) != partition:
                raise ValueError("Partition receipt does not match message")
            message._acknowledge = settle

            async def process() -> None:
                await self.running.wait()
                await self.handler(message)

            await run_with_lease(process, renew, duration, started)
            if self.options.auto_commit and not decision.done():
                await settle(False)
            if not decision.done():
                # A returned manual callback must not renew forever without ACK.
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("Stream delivery lease expired")
                await asyncio.wait_for(asyncio.shield(decision), remaining)
        finally:
            terminal = True
            if not decision.done():
                decision.cancel()
            if not settled:
                # Callback has ended or cancellation joined it. Safe immediate
                # requeue remains conditional on the exact live storage token.
                await protocol.settle(stream, group, partition, identity, token, True)
