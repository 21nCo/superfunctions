"""Stream implementation."""

from typing import Any, Optional, Callable
from flowfn.stream.types import (
    Message,
    PublishOptions,
    SubscribeOptions,
    MessageHandler,
    ConsumerOptions,
    StreamInfo,
    TrimStrategy
)
from flowfn.adapters.base import FlowAdapter
import uuid
import time


class Stream:
    """Stream for pub/sub messaging."""
    
    def __init__(
        self,
        name: str,
        adapter: FlowAdapter,
        options: Optional[dict[str, Any]] = None
    ):
        self.name = name
        self._adapter = adapter
        self._options = options or {}
        self._messages: dict[str, Message] = {}
    
    async def publish(
        self,
        data: Any,
        opts: Optional[PublishOptions] = None
    ) -> str:
        """Publish a message."""
        options = opts or PublishOptions()
        
        message = Message(
            id=str(uuid.uuid4()),
            stream=self.name,
            data=data,
            headers=options.headers,
            timestamp=self._now(),
            partition=options.partition,
            key=options.key
        )
        
        # Store locally
        self._messages[message.id] = message
        
        # Auto-trim if needed
        max_length = self._options.get('max_length')
        if max_length and len(self._messages) > max_length:
            await self.trim(TrimStrategy(max_length=max_length))
        
        # Publish to adapter
        return await self._adapter.publish(self.name, message)
    
    async def publish_batch(
        self,
        messages: list[dict[str, Any]]
    ) -> list[str]:
        """Publish multiple messages."""
        results = []
        for msg in messages:
            msg_id = await self.publish(
                msg['data'],
                msg.get('opts')
            )
            results.append(msg_id)
        return results
    
    async def subscribe(
        self,
        handler: Optional[MessageHandler] = None,
        opts: Optional[SubscribeOptions] = None
    ) -> Any:
        """Subscribe to stream."""
        def decorator(func: MessageHandler) -> Any:
            actual_handler = handler or func
            return self._adapter.subscribe(self.name, actual_handler)
        
        if handler:
            return await self._adapter.subscribe(self.name, handler)
        
        return decorator
    
    def create_consumer(
        self,
        consumer_id: str,
        opts: ConsumerOptions
    ) -> 'Consumer':
        """Create a consumer."""
        return Consumer(
            self.name,
            consumer_id,
            opts,
            self._adapter,
            self._messages
        )
    
    async def get_info(self) -> StreamInfo:
        """Get stream info."""
        info = await self._adapter.get_stream_info(self.name)
        info.length = len(self._messages)
        return info
    
    async def trim(self, strategy: TrimStrategy) -> int:
        """Trim old messages."""
        now = self._now()
        to_delete: list[str] = []
        
        if strategy.max_length:
            # Sort by timestamp and keep newest
            sorted_msgs = sorted(
                self._messages.items(),
                key=lambda x: x[1].timestamp,
                reverse=True
            )
            
            if len(sorted_msgs) > strategy.max_length:
                to_remove = sorted_msgs[strategy.max_length:]
                to_delete.extend([msg_id for msg_id, _ in to_remove])
        
        if strategy.max_age_seconds:
            max_age = strategy.max_age_seconds * 1000
            for msg_id, msg in self._messages.items():
                if now - msg.timestamp > max_age:
                    to_delete.append(msg_id)
        
        # Remove duplicates
        unique_to_delete = set(to_delete)
        for msg_id in unique_to_delete:
            self._messages.pop(msg_id, None)
        
        return len(unique_to_delete)
    
    async def get_messages(
        self,
        start: str,
        end: str,
        count: Optional[int] = None
    ) -> list[Message]:
        """Get messages by ID range."""
        all_messages = sorted(
            self._messages.values(),
            key=lambda m: m.timestamp
        )
        
        # Filter by range
        filtered = [m for m in all_messages if start <= m.id <= end]
        
        # Apply count limit
        if count is not None and count > 0:
            filtered = filtered[:count]
        
        return filtered
    
    async def replay(
        self,
        from_timestamp: int,
        handler: MessageHandler
    ) -> int:
        """Replay messages from timestamp."""
        messages = sorted(
            [m for m in self._messages.values() if m.timestamp >= from_timestamp],
            key=lambda m: m.timestamp
        )
        
        for message in messages:
            await handler(message)
        
        return len(messages)
    
    def get_message_count(self) -> int:
        """Get message count."""
        return len(self._messages)
    
    async def close(self) -> None:
        """Close the stream."""
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
        messages: dict[str, Message]
    ):
        self.stream = stream
        self.consumer_id = consumer_id
        self.opts = opts
        self._adapter = adapter
        self._messages = messages
        self._subscription: Any = None
        self._paused = False
    
    async def subscribe(self, handler: MessageHandler) -> None:
        """Subscribe with handler."""
        # Replay from beginning if requested
        if self.opts.from_beginning and self._messages:
            sorted_messages = sorted(
                self._messages.values(),
                key=lambda m: m.timestamp
            )
            
            for msg in sorted_messages:
                if not self._paused:
                    await handler(msg)
        
        # Subscribe to new messages
        self._subscription = await self._adapter.consume(
            self.stream,
            self.opts.group_id,
            self.consumer_id,
            handler
        )
    
    async def pause(self) -> None:
        """Pause consumer."""
        self._paused = True
    
    async def resume(self) -> None:
        """Resume consumer."""
        self._paused = False
    
    async def close(self) -> None:
        """Close consumer."""
        if self._subscription:
            await self._subscription.unsubscribe()
