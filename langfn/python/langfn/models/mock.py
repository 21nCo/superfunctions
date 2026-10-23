from __future__ import annotations

import json
from typing import Any, AsyncIterator, Callable, Optional, Sequence

from ..core.types import (
    ChatRequest,
    ChatResponse,
    CompletionRequest,
    CompletionResponse,
    ContentEvent,
    EndEvent,
    Message,
    StreamEvent,
    TokenUsage,
)
from .base import ChatModel


class MockChatModel(ChatModel):
    provider = "mock"
    model = "mock-1"

    def __init__(
        self,
        *,
        responses: Optional[Sequence[str]] = None,
        streams: Optional[Sequence[Sequence[StreamEvent]]] = None,
        usage: Optional[TokenUsage | dict[str, int]] = None,
        complete_handler: Optional[Callable[[CompletionRequest], Any]] = None,
        chat_handler: Optional[Callable[[ChatRequest], Any]] = None,
    ):
        self._responses = list(responses or [])
        self._streams = list(streams or [])
        self._usage = usage if isinstance(usage, TokenUsage) or usage is None else TokenUsage.from_counts(
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
        )
        self._complete_handler = complete_handler
        self._chat_handler = chat_handler

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        if self._complete_handler is not None:
            result = self._complete_handler(request)
            if isinstance(result, CompletionResponse):
                return result
            if hasattr(result, "__await__"):
                return await result
        content = self._responses.pop(0) if self._responses else request.prompt
        return CompletionResponse(content=content, raw={"mock": True}, usage=self._usage)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        if self._chat_handler is not None:
            result = self._chat_handler(request)
            if isinstance(result, ChatResponse):
                return result
            if hasattr(result, "__await__"):
                return await result
        content = self._responses.pop(0) if self._responses else json.dumps({"echo": request.messages})
        return ChatResponse(
            message=Message(role="assistant", content=content),
            raw={"mock": True},
            usage=self._usage,
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        if self._streams:
            events = self._streams.pop(0)
            for event in events:
                yield event
            return
        response = await self.complete(request)
        yield ContentEvent(content=response.content, delta=response.content)
        yield EndEvent(finish_reason="stop")
