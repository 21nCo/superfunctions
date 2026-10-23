"""In-memory consumer groups with acknowledgement and pending redelivery."""

import asyncio

from flowfn.stream.types import ConsumerOptions, Message, MessageHandler


class MemoryConsumerGroup:
    def __init__(self, messages: list[Message]) -> None:
        self.unacknowledged = {message.id for message in messages}
        self.pending: asyncio.Queue[Message] = asyncio.Queue()
        for message in messages:
            self.pending.put_nowait(message)
        self.consumers: dict[str, MemoryConsumer] = {}

    def publish(self, message: Message) -> None:
        self.unacknowledged.add(message.id)
        self.pending.put_nowait(message)

    def subscribe(
        self, name: str, handler: MessageHandler, options: ConsumerOptions
    ) -> "MemoryConsumer":
        if name in self.consumers:
            raise ValueError(f"Consumer already registered: {name}")
        subscription = MemoryConsumer(self, name, handler, options)
        self.consumers[name] = subscription
        subscription.start()
        return subscription

    async def close(self) -> None:
        await asyncio.gather(
            *(consumer.unsubscribe() for consumer in list(self.consumers.values()))
        )


class MemoryConsumer:
    def __init__(
        self,
        group: MemoryConsumerGroup,
        name: str,
        handler: MessageHandler,
        options: ConsumerOptions,
    ) -> None:
        self.group = group
        self.name = name
        self.handler = handler
        self.options = options
        self.running = asyncio.Event()
        self.running.set()
        self.tasks: list[asyncio.Task[None]] = []
        self.closed = False

    def start(self) -> None:
        self.tasks = [
            asyncio.create_task(self._worker()) for _ in range(self.options.max_in_flight)
        ]

    async def _worker(self) -> None:
        while not self.closed:
            await self.running.wait()
            original = await self.group.pending.get()
            decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
            try:
                await self.running.wait()
                message = original.model_copy(deep=True)

                async def settle(requeue: bool, target: asyncio.Future[bool] = decision, message_id: str = original.id) -> None:
                    if not target.done():
                        target.set_result(requeue)
                        if not requeue:
                            self.group.unacknowledged.discard(message_id)

                message._acknowledge = settle
                try:
                    await self.handler(message)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # A failed handler leaves the message eligible for another attempt.
                    await settle(True)
                    await asyncio.sleep(0.01)
                else:
                    if self.options.auto_commit:
                        await settle(False)
                requeue = await asyncio.shield(decision)
                if requeue:
                    self.group.pending.put_nowait(original)
            except asyncio.CancelledError:
                # Explicit ack/drop wins even if disconnection races handler cleanup.
                if not decision.done() or decision.result():
                    self.group.pending.put_nowait(original)
                raise
            finally:
                if not decision.done():
                    decision.cancel()  # A disconnected delivery cannot acknowledge a later claim.
                self.group.pending.task_done()

    async def pause(self) -> None:
        self.running.clear()

    async def resume(self) -> None:
        if self.closed:
            raise RuntimeError("Consumer is closed")
        self.running.set()

    async def unsubscribe(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.group.consumers.pop(self.name, None)
        for task in self.tasks:
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks.clear()
