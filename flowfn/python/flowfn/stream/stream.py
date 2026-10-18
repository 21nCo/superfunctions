"""Stream implementation."""

from typing import Any, Optional, Callable, Awaitable
from flowfn.stream.types import (
    Message,
    PublishOptions,
    SubscribeOptions,
    MessageHandler,
    ConsumerOptions,
    StreamInfo,
    TrimStrategy,
    StreamOptions,
)
from flowfn.adapters.base import FlowAdapter
import asyncio
from flowfn.core.lifecycle import Admissions
import uuid
import time


class Stream:
    """Stream for pub/sub messaging."""

    def __init__(self, name: str, adapter: FlowAdapter, options: Optional[dict[str, Any]] = None):
        self.name = name
        self._adapter = adapter
        self._options = options or {}
        retention = StreamOptions.model_validate(self._options)
        self._retention = TrimStrategy(
            max_length=retention.max_length,
            max_age_seconds=retention.retention / 1000 if retention.retention is not None else None,
        )
        self._messages: dict[str, Message] = {}
        self._registrations: list[asyncio.Task[Any]] = []
        self._subscriptions: list[Any] = []
        self._closed = False
        self._admissions = Admissions(lambda: self._closed)
        self._consumers: list[Consumer] = []

    async def publish(self, data: Any, opts: Optional[PublishOptions] = None) -> str:
        """Publish a message."""
        async with self._admissions.track():
            await self.ready()
            options = opts or PublishOptions()

            message = Message(
                id=str(uuid.uuid4()),
                stream=self.name,
                data=data,
                headers=options.headers,
                timestamp=self._now(),
                partition=options.partition,
                key=options.key,
            )

            message_id = await self._adapter.publish(self.name, message)
            await self._apply_retention()
            return message_id

    async def publish_batch(self, messages: list[dict[str, Any]]) -> list[str]:
        """Publish multiple messages."""
        results = []
        for msg in messages:
            msg_id = await self.publish(msg["data"], msg.get("opts"))
            results.append(msg_id)
        return results

    def subscribe(
        self, handler: Optional[MessageHandler] = None, opts: Optional[SubscribeOptions] = None
    ) -> Any:
        """Register a decorator, or await subscribe(handler) for readiness."""
        if self._closed:
            raise RuntimeError("Stream is closed")

        async def register(func: MessageHandler) -> Any:
            await self._apply_retention()
            subscription = await self._adapter.subscribe(self.name, func)
            self._subscriptions.append(subscription)
            return subscription

        if handler is not None:
            task = asyncio.create_task(register(handler))
            self._registrations.append(task)
            return task

        def decorator(func: MessageHandler) -> MessageHandler:
            self._registrations.append(asyncio.create_task(register(func)))
            return func

        return decorator

    async def ready(self) -> None:
        """Wait for decorator registrations before publishing or external use."""
        if self._closed:
            raise RuntimeError("Stream is closed")
        registrations = list(self._registrations)
        if registrations:
            await asyncio.gather(*(asyncio.shield(task) for task in registrations))
            self._registrations = [
                task for task in self._registrations if task not in registrations
            ]

    def create_consumer(self, consumer_id: str, opts: ConsumerOptions) -> "Consumer":
        """Create a consumer."""
        if self._closed:
            raise RuntimeError("Stream is closed")
        consumer = Consumer(self.name, consumer_id, opts, self._adapter, self._messages, self._apply_retention)
        self._consumers.append(consumer)
        return consumer

    async def _apply_retention(self) -> None:
        if self._retention.max_length is not None or self._retention.max_age_seconds is not None:
            await self._adapter.trim_stream(self.name, self._retention)

    async def get_info(self) -> StreamInfo:
        """Get stream info."""
        await self._apply_retention()
        info = await self._adapter.get_stream_info(self.name)
        return info

    async def trim(self, strategy: TrimStrategy) -> int:
        """Trim old messages."""
        return await self._adapter.trim_stream(self.name, strategy)

    async def get_messages(
        self, start: str, end: str, count: Optional[int] = None
    ) -> list[Message]:
        """Get messages by ID range."""
        await self._apply_retention()
        all_messages = sorted(
            await self._adapter.get_stream_messages(self.name), key=lambda m: m.timestamp
        )

        # Filter by range
        filtered = [m for m in all_messages if start <= m.id <= end]

        # Apply count limit
        if count is not None and count > 0:
            filtered = filtered[:count]

        return filtered

    async def replay(self, from_timestamp: int, handler: MessageHandler) -> int:
        """Replay messages from timestamp."""
        await self._apply_retention()
        messages = sorted(
            [
                m
                for m in await self._adapter.get_stream_messages(self.name)
                if m.timestamp >= from_timestamp
            ],
            key=lambda m: m.timestamp,
        )

        for message in messages:
            await handler(message)

        return len(messages)

    async def get_message_count(self) -> int:
        """Get message count."""
        return (await self.get_info()).length

    async def close(self) -> None:
        """Finish registration and unsubscribe before adapter cleanup."""
        self._closed = True
        await self._admissions.drain()
        for consumer in self._consumers:
            await consumer.close()
        if self._registrations:
            await asyncio.gather(*self._registrations, return_exceptions=True)
            self._registrations.clear()
        for subscription in self._subscriptions:
            await subscription.unsubscribe()
        self._subscriptions.clear()
        self._messages.clear()

    def _now(self) -> int:
        """Get current timestamp in ms."""
        return int(time.time() * 1000)


class Consumer:
    """Stream consumer with group support."""

    def __init__(
        self,
        stream: str,
        consumer_id: str,
        opts: ConsumerOptions,
        adapter: FlowAdapter,
        messages: dict[str, Message],
        retention: Optional[Callable[[], Awaitable[None]]] = None,
    ):
        self.stream = stream
        self.consumer_id = consumer_id
        self.opts = opts
        self._adapter = adapter
        self._messages = messages
        self._retention = retention
        self._subscription: Any = None
        self._paused = False
        self._closed = False
        self._admissions = Admissions(lambda: self._closed)

    async def subscribe(self, handler: MessageHandler) -> None:
        """Subscribe with handler."""
        async with self._admissions.track():
            if self._subscription is not None:
                raise RuntimeError("Consumer is already subscribed")
            if self._retention is not None:
                await self._retention()
            self._subscription = await self._adapter.consume(
                self.stream, self.opts.group_id, self.consumer_id, handler, self.opts
            )
            if self._paused:
                await self._subscription.pause()

    async def pause(self) -> None:
        """Pause consumer."""
        self._paused = True
        if self._subscription is not None:
            await self._subscription.pause()

    async def resume(self) -> None:
        """Resume consumer."""
        if self._closed:
            raise RuntimeError("Consumer is closed")
        self._paused = False
        if self._subscription is not None:
            await self._subscription.resume()

    async def close(self) -> None:
        """Close consumer."""
        self._closed = True
        await self._admissions.drain()
        if self._subscription:
            await self._subscription.unsubscribe()
