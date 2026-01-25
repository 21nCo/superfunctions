from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from ..core.errors import LangFnError, ProviderAuthError
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


@dataclass
class OllamaChatModel(ChatModel):
    model: str = "llama3"
    base_url: str = "http://localhost:11434"
    timeout: float = 120.0
    transport: Optional[Any] = None

    provider: str = "ollama"

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url,
            timeout=self.timeout,
            transport=self.transport,
        )

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        chat_request = ChatRequest(messages=[{"role": "user", "content": request.prompt}], metadata=request.metadata)
        chat_resp = await self.chat(chat_request)
        return CompletionResponse(
            content=chat_resp.message.content,
            raw=chat_resp.raw,
            usage=chat_resp.usage,
        )

    async def chat(self, request: ChatRequest) -> ChatResponse:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": request.messages,
            "stream": False,
        }
        # Note: Ollama tools support omitted for simplicity in v0.1
        
        async with self._client() as client:
            try:
                resp = await client.post("/api/chat", json=payload)
            except httpx.ConnectError as exc:
                raise LangFnError(
                    "Could not connect to Ollama. Is it running?",
                    code="CONNECTION_ERROR",
                    provider=self.provider
                ) from exc

        self._raise_for_status(resp)
        data = resp.json()
        
        message = data.get("message", {})
        usage_data = {} # Ollama often returns usage at end of stream or in response
        if "eval_count" in data:
             usage_data["completion_tokens"] = data["eval_count"]
        if "prompt_eval_count" in data:
             usage_data["prompt_tokens"] = data["prompt_eval_count"]
        
        token_usage = TokenUsage(
             prompt_tokens=int(usage_data.get("prompt_tokens", 0)),
             completion_tokens=int(usage_data.get("completion_tokens", 0))
        )

        return ChatResponse(
            message=Message(role=message.get("role", "assistant"), content=message.get("content", "")),
            raw=data,
            usage=token_usage,
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": request.prompt}],
            "stream": True,
        }
        async with self._client() as client:
            try:
                async with client.stream("POST", "/api/chat", json=payload) as resp:
                    self._raise_for_status(resp)
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        
                        if chunk.get("done"):
                            yield EndEvent(finish_reason="stop")
                            return
                        
                        msg = chunk.get("message", {})
                        content = msg.get("content", "")
                        if content:
                            yield ContentEvent(content=content, delta=content)
            except httpx.ConnectError as exc:
                raise LangFnError(
                    "Could not connect to Ollama", code="CONNECTION_ERROR", provider=self.provider
                ) from exc
                
        yield EndEvent(finish_reason="stop")

    def _raise_for_status(self, resp: httpx.Response) -> None:
        if 200 <= resp.status_code < 300:
            return
        raise LangFnError(
            f"Ollama request failed ({resp.status_code})",
            code="PROVIDER_ERROR",
            provider=self.provider,
            metadata={"status": resp.status_code, "body": resp.text},
        )
