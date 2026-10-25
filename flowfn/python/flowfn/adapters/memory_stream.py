"""Process-local stream progress and fenced receipts independent of retained payload."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Callable

from flowfn.adapters.stream_lease import run_with_lease
from flowfn.core.lease_expiry import LeaseExpiry
from flowfn.stream.types import ConsumerOptions, Message, MessageHandler


@dataclass
class Receipt:
    identity: str
    key: int | str
    owner: object
    token: object
    done: asyncio.Future[None]
    expiry: LeaseExpiry | None = None


class MemoryConsumerGroup:
    def __init__(self, history: Callable[[], list[Message]], cutoff: int, *, partitioned: bool) -> None:
        self.history = history
        self.partitioned = partitioned
        self.cutoff = cutoff
        self.cursors: dict[int, int] = {}
        self.pending: dict[int | str, Receipt] = {}
        self.retry: list[str] = []
        self.consumers: dict[str, MemoryConsumer] = {}
        self.changed = asyncio.Event()

    def _cursor_key(self, message: Message) -> int:
        if not self.partitioned:
            return 0
        if message.partition is None:
            raise RuntimeError('Configured stream contains an unpartitioned message')
        return message.partition

    def _delivery_key(self, message: Message) -> int | str:
        # Legacy streams allow concurrent messages, but never concurrent receipts
        # for the same message. Configured streams additionally serialize a partition.
        return self._cursor_key(message) if self.partitioned else message.id

    def _message(self, identity: str) -> Message | None:
        return next((message for message in self.history() if message.id == identity), None)

    @property
    def unacknowledged(self) -> set[str]:
        retained = self.history()
        pending = {receipt.identity for receipt in self.pending.values()}
        retry = set(self.retry)
        return {message.id for message in retained if message.id in pending or message.id in retry or
                (message.offset or 0) > self.cursors.get(self._cursor_key(message), self.cutoff)}

    def publish(self, message: Message) -> None:
        self.changed.set()

    def trim(self) -> None:
        retained = {message.id for message in self.history()}
        self.retry = [identity for identity in self.retry if identity in retained]
        self.changed.set()

    def _current(self, receipt: Receipt) -> bool:
        current = self.pending.get(receipt.key)
        return current is receipt and current.token is receipt.token

    def _release(self, receipt: Receipt, requeue: bool) -> None:
        if not self._current(receipt):
            return
        del self.pending[receipt.key]
        if receipt.expiry is not None:
            receipt.expiry.close()
        if requeue and self._message(receipt.identity) is not None:
            self.retry.append(receipt.identity)
        if not receipt.done.done():
            receipt.done.set_result(None)
        self.changed.set()

    async def settle(self, receipt: Receipt, requeue: bool) -> None:
        if not self._current(receipt) or receipt.expiry is None or receipt.expiry.expired:
            return
        if time.monotonic() >= receipt.expiry.deadline:
            self._release(receipt, True)
            return
        self._release(receipt, requeue)

    async def renew(self, receipt: Receipt, duration: int) -> bool:
        if not self._current(receipt) or receipt.expiry is None or self._message(receipt.identity) is None:
            return False
        return receipt.expiry.renew(time.monotonic() + duration / 1000)

    def claim(self, owner: object, duration: int) -> tuple[Message, Receipt, float] | None:
        retained = self.history()
        retry = set(self.retry)
        candidates = [message for message in retained if message.id in retry]
        candidates.extend(message for message in retained if message.id not in retry and
                          (message.offset or 0) > self.cursors.get(self._cursor_key(message), self.cutoff))
        for message in candidates:
            key = self._delivery_key(message)
            if key in self.pending:
                continue
            if message.id in retry:
                self.retry.remove(message.id)
            cursor_key = self._cursor_key(message)
            self.cursors[cursor_key] = max(self.cursors.get(cursor_key, self.cutoff), message.offset or 0)
            receipt = Receipt(message.id, key, owner, object(), asyncio.get_running_loop().create_future())
            self.pending[key] = receipt
            started = time.monotonic()
            def expire(current: Receipt = receipt) -> None:
                self._release(current, True)
            receipt.expiry = LeaseExpiry(started + duration / 1000, expire)
            return message.model_copy(deep=True), receipt, started
        return None

    def subscribe(self, name: str, handler: MessageHandler, options: ConsumerOptions) -> MemoryConsumer:
        if name in self.consumers:
            raise ValueError(f'Consumer already registered: {name}')
        consumer = MemoryConsumer(self, name, handler, options)
        self.consumers[name] = consumer
        consumer.start()
        return consumer

    async def close(self) -> None:
        await asyncio.gather(*(consumer.unsubscribe() for consumer in list(self.consumers.values())))
        for receipt in list(self.pending.values()):
            self._release(receipt, False)
        self.retry.clear()


class MemoryConsumer:
    def __init__(self, group: MemoryConsumerGroup, name: str, handler: MessageHandler, options: ConsumerOptions) -> None:
        self.group, self.name, self.handler, self.options = group, name, handler, options
        self.running = asyncio.Event()
        self.running.set()
        self.closed = False
        self.owner = object()
        self.tasks: list[asyncio.Task[None]] = []

    def start(self) -> None:
        self.tasks = [asyncio.create_task(self._worker()) for _ in range(self.options.max_in_flight)]

    async def _worker(self) -> None:
        while not self.closed:
            await self.running.wait()
            self.group.changed.clear()
            claimed = self.group.claim(self.owner, self.options.visibility_timeout)
            if claimed is None:
                await self.group.changed.wait()
                continue
            message, receipt, started = claimed
            async def settle(requeue: bool, current: Receipt = receipt) -> None:
                await self.group.settle(current, requeue)
            async def renew(current: Receipt = receipt) -> bool:
                return await self.group.renew(current, self.options.visibility_timeout)
            async def process(payload: Message = message, current: Receipt = receipt) -> None:
                try:
                    await self.handler(payload)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    await self.group.settle(current, True)
                    raise
            message._acknowledge = settle
            try:
                await run_with_lease(process, renew, self.options.visibility_timeout, started)
                if self.options.auto_commit:
                    await settle(False)
                await asyncio.shield(receipt.done)
            except asyncio.CancelledError:
                self.group._release(receipt, True)
                raise
            except Exception:
                # A trimmed payload prevents renewal but must not release its barrier early.
                await asyncio.shield(receipt.done)
                await asyncio.sleep(.01)

    async def pause(self) -> None:
        self.running.clear()

    async def resume(self) -> None:
        if self.closed:
            raise RuntimeError('Consumer is closed')
        self.running.set()
        self.group.changed.set()

    async def unsubscribe(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.group.consumers.pop(self.name, None)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks.clear()
        # Cancellation can arrive while a worker waits inside its error handler.
        # Only release after every owned callback has acknowledged cancellation.
        for receipt in list(self.group.pending.values()):
            if receipt.owner is self.owner:
                self.group._release(receipt, True)
