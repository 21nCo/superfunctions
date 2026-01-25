from __future__ import annotations

from abc import ABC, abstractmethod

from ..core.types import ChatRequest, ChatResponse, CompletionRequest, CompletionResponse, StreamEvent


class ChatModel(ABC):
    provider: str
    model: str

    @abstractmethod
    async def complete(self, request: CompletionRequest) -> CompletionResponse: ...

    @abstractmethod
    async def chat(self, request: ChatRequest) -> ChatResponse: ...

    @abstractmethod
    async def stream(self, request: CompletionRequest):  # AsyncIterator[StreamEvent]
        ...

