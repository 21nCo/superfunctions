from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional

from ..core.errors import ProviderAuthError, ProviderError, RateLimitError
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
    ToolCall,
)
from .base import ChatModel
from .transport import get_async_client


@dataclass
class MistralChatModel(ChatModel):
    api_key: str = ""
    model: str = "mistral-small-latest"
    base_url: str = "https://api.mistral.ai/v1"
    timeout: float = 60.0
    transport: Optional[Any] = None
    provider: str = "mistral"

    def _client(self):
        headers = {"content-type": "application/json", "authorization": f"Bearer {self.api_key}"}
        return get_async_client(base_url=self.base_url, headers=headers, timeout=self.timeout, transport=self.transport)

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        chat = await self.chat(ChatRequest(messages=[{"role": "user", "content": request.prompt}], metadata=request.metadata))
        return CompletionResponse(content=chat.message.content, raw=chat.raw, usage=chat.usage)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        payload: Dict[str, Any] = {"model": self.model, "messages": request.messages}
        if request.tools:
            payload["tools"] = [
                {"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema}}
                for t in request.tools
            ]
        if request.tool_choice is not None:
            payload["tool_choice"] = request.tool_choice

        resp = await self._client().post("/chat/completions", json=payload)
        self._raise_for_status(resp)
        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        raw_tool_calls = message.get("tool_calls") or []
        tool_calls: List[ToolCall] = []
        for raw in raw_tool_calls:
            fn = raw.get("function") or {}
            try:
                arguments = json.loads(fn.get("arguments") or "{}")
            except Exception:
                arguments = {}
            tool_calls.append(ToolCall(id=str(raw.get("id") or ""), name=str(fn.get("name") or ""), arguments=arguments))
        usage = data.get("usage") or {}
        return ChatResponse(
            message=Message(role="assistant", content=message.get("content") or ""),
            tool_calls=tool_calls or None,
            raw=data,
            usage=TokenUsage.from_counts(
                prompt_tokens=int(usage.get("prompt_tokens", 0)),
                completion_tokens=int(usage.get("completion_tokens", 0)),
            ),
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        response = await self.complete(request)
        yield ContentEvent(content=response.content, delta=response.content)
        yield EndEvent(finish_reason="stop")

    def _raise_for_status(self, resp) -> None:
        if 200 <= resp.status_code < 300:
            return
        body = resp.text
        if resp.status_code == 401:
            raise ProviderAuthError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        if resp.status_code == 429:
            raise RateLimitError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        raise ProviderError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
