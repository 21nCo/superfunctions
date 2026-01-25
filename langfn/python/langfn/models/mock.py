from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, List, Optional, Sequence
from uuid import uuid4

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
        usage: Optional[TokenUsage] = None,
    ):
        self._responses = list(responses or [])
        self._streams = list(streams or [])
        self._usage = usage

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        content = self._responses.pop(0) if self._responses else request.prompt
        return CompletionResponse(content=content, raw={"mock": True}, usage=self._usage)

    async def chat(self, request: ChatRequest) -> ChatResponse:
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

        content = self._responses.pop(0) if self._responses else request.prompt
        yield ContentEvent(content=content, delta=content)
        yield EndEvent(finish_reason="stop")

