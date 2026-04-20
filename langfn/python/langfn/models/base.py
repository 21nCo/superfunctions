from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Optional, Protocol, Sequence

from ..core.types import ChatRequest, ChatResponse, CompletionRequest, CompletionResponse, StreamEvent


class ChatModel(ABC):
    provider: str
    model: str

    @abstractmethod
    async def complete(self, request: CompletionRequest) -> CompletionResponse: ...

    @abstractmethod
    async def chat(self, request: ChatRequest) -> ChatResponse: ...

    @abstractmethod
    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]: ...

    async def _complete_from_chat(self, request: CompletionRequest) -> CompletionResponse:
        chat = await self.chat(ChatRequest(messages=[{"role": "user", "content": request.prompt}], metadata=request.metadata))
        return CompletionResponse(content=chat.message.content, raw=chat.raw, usage=chat.usage)


CompleteHandler = Callable[[CompletionRequest], Awaitable[CompletionResponse]]
ChatHandler = Callable[[ChatRequest], Awaitable[ChatResponse]]
StreamHandler = Callable[[CompletionRequest], AsyncIterator[StreamEvent]]


@dataclass
class CustomChatModel(ChatModel):
    model: str = "custom-model"
    provider: str = "custom"
    complete_handler: Optional[CompleteHandler] = None
    chat_handler: Optional[ChatHandler] = None
    stream_handler: Optional[Callable[[CompletionRequest], AsyncIterator[StreamEvent]]] = None

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        if self.complete_handler is None:
            if self.chat_handler is None:
                raise RuntimeError("CustomChatModel requires a complete_handler or chat_handler")
            return await self._complete_from_chat(request)
        return await self.complete_handler(request)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        if self.chat_handler is None:
            if self.complete_handler is None:
                raise RuntimeError("CustomChatModel requires a chat_handler or complete_handler")
            content = await self.complete_handler(
                CompletionRequest(prompt=request.messages[-1]["content"], metadata=request.metadata)
            )
            return ChatResponse(message={"role": "assistant", "content": content.content}, raw=content.raw, usage=content.usage)
        return await self.chat_handler(request)

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        if self.stream_handler is not None:
            async for event in self.stream_handler(request):
                yield event
            return
        response = await self.complete(request)
        yield {"type": "content", "content": response.content, "delta": response.content}
        yield {"type": "end", "finish_reason": "stop"}
