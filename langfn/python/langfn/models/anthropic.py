from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from ..core.errors import ContextLengthError, LangFnError, ProviderAuthError, RateLimitError
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
    ToolSpec,
)
from .base import ChatModel


@dataclass
class AnthropicChatModel(ChatModel):
    api_key: str
    model: str = "claude-3-opus-20240229"
    base_url: str = "https://api.anthropic.com/v1"
    timeout: float = 60.0
    version: str = "2023-06-01"
    transport: Optional[Any] = None

    provider: str = "anthropic"

    def _client(self) -> httpx.AsyncClient:
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": self.version,
            "content-type": "application/json",
        }
        return httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
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
        system, messages = _split_system_message(request.messages)
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": 4096,  # Default required by Anthropic
        }
        if system:
            payload["system"] = system

        if request.tools:
            payload["tools"] = [_to_anthropic_tool(t) for t in request.tools]
        if request.tool_choice:
             # Anthropic tool choice format: {type: "tool", name: "tool_name"} or {type: "auto"}
             if isinstance(request.tool_choice, str):
                  if request.tool_choice in ["auto", "any"]:
                       payload["tool_choice"] = {"type": request.tool_choice}
                  else:
                       payload["tool_choice"] = {"type": "tool", "name": request.tool_choice}
             else:
                  payload["tool_choice"] = request.tool_choice

        async with self._client() as client:
            resp = await client.post("/messages", json=payload)
        self._raise_for_status(resp)

        data = resp.json()
        content_blocks = data.get("content", [])
        text_content = ""
        tool_calls = []

        for block in content_blocks:
            if block["type"] == "text":
                text_content += block["text"]
            elif block["type"] == "tool_use":
                tool_calls.append(
                    ToolCall(
                        id=block["id"],
                        name=block["name"],
                        arguments=block["input"],
                    )
                )

        usage = data.get("usage", {})
        token_usage = TokenUsage(
            prompt_tokens=int(usage.get("input_tokens", 0)),
            completion_tokens=int(usage.get("output_tokens", 0)),
        )

        return ChatResponse(
            message=Message(role="assistant", content=text_content),
            tool_calls=tool_calls or None,
            raw=data,
            usage=token_usage,
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": request.prompt}],
            "max_tokens": 4096,
            "stream": True,
        }
        async with self._client() as client:
            async with client.stream("POST", "/messages", json=payload) as resp:
                self._raise_for_status(resp)
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    
                    data_str = line[len("data:") :].strip()
                    try:
                        event = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue

                    evt_type = event.get("type")
                    if evt_type == "content_block_delta":
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            yield ContentEvent(content=text, delta=text)
                    elif evt_type == "message_stop":
                        yield EndEvent(finish_reason="stop")
                        return
                    elif evt_type == "error":
                        # Handle stream error
                        pass

        yield EndEvent(finish_reason="stop")

    def _raise_for_status(self, resp: httpx.Response) -> None:
        if 200 <= resp.status_code < 300:
            return
        
        body = None
        try:
            body = resp.json()
        except Exception:
            body = resp.text

        if resp.status_code == 401:
            raise ProviderAuthError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        if resp.status_code == 429:
             raise RateLimitError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        if resp.status_code == 400:
             # Check for context length error (overloaded_error or similar in Anthropic)
             err = body.get("error", {}) if isinstance(body, dict) else {}
             if err.get("type") == "invalid_request_error" and "prompt is too long" in err.get("message", ""):
                  raise ContextLengthError(provider=self.provider, metadata={"status": resp.status_code, "body": body})

        raise LangFnError(
            f"Anthropic request failed ({resp.status_code})",
            code="PROVIDER_ERROR",
            provider=self.provider,
            metadata={"status": resp.status_code, "body": body},
        )


def _split_system_message(messages: List[Dict[str, Any]]):
    system = None
    rest = []
    for m in messages:
        if m.get("role") == "system":
            system = m.get("content")
        else:
            rest.append(m)
    return system, rest


def _to_anthropic_tool(tool: ToolSpec) -> Dict[str, Any]:
    return {
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.input_schema or {"type": "object", "properties": {}},
    }
