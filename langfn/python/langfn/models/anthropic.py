from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional

from ..core.errors import ContextLengthError, ProviderAuthError, ProviderError, RateLimitError
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
from ..tools.policy import resolve_secret
from .base import ChatModel
from .transport import get_async_client


@dataclass
class AnthropicChatModel(ChatModel):
    api_key: str = ""
    api_key_ref: Optional[str] = None
    model: str = "claude-3-opus-20240229"
    base_url: str = "https://api.anthropic.com/v1"
    timeout: float = 60.0
    version: str = "2023-06-01"
    secret_provider: Optional[Any] = None
    transport: Optional[Any] = None
    provider: str = "anthropic"

    def _client(self):
        api_key = self.api_key or resolve_secret(self.api_key_ref, self.secret_provider)
        headers = {
            "x-api-key": api_key or "",
            "anthropic-version": self.version,
            "content-type": "application/json",
        }
        return get_async_client(base_url=self.base_url, headers=headers, timeout=self.timeout, transport=self.transport)

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        return await self._complete_from_chat(request)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        system, messages = _split_system_message(request.messages)
        payload: Dict[str, Any] = {"model": self.model, "messages": messages, "max_tokens": 4096}
        if system:
            payload["system"] = system
        if request.tools:
            payload["tools"] = [_to_anthropic_tool(t) for t in request.tools]
        if request.tool_choice is not None:
            if isinstance(request.tool_choice, str):
                payload["tool_choice"] = {"type": "auto"} if request.tool_choice == "auto" else {"type": "tool", "name": request.tool_choice}
            else:
                payload["tool_choice"] = request.tool_choice

        resp = await self._client().post("/messages", json=payload)
        self._raise_for_status(resp)
        data = resp.json()
        blocks = data.get("content") or []
        text = ""
        tool_calls: List[ToolCall] = []
        for block in blocks:
            if block.get("type") == "text":
                text += block.get("text", "")
            elif block.get("type") == "tool_use":
                tool_calls.append(
                    ToolCall(id=str(block.get("id") or ""), name=str(block.get("name") or ""), arguments=block.get("input") or {})
                )
        usage = data.get("usage") or {}
        return ChatResponse(
            message=Message(role="assistant", content=text),
            tool_calls=tool_calls or None,
            raw=data,
            usage=TokenUsage.from_counts(
                prompt_tokens=int(usage.get("input_tokens", 0)),
                completion_tokens=int(usage.get("output_tokens", 0)),
            ),
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": request.prompt}],
            "max_tokens": 4096,
            "stream": True,
        }
        async with self._client().stream("POST", "/messages", json=payload) as resp:
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
                    delta = event.get("delta") or {}
                    if delta.get("type") == "text_delta":
                        text = delta.get("text", "")
                        yield ContentEvent(content=text, delta=text)
                elif evt_type == "message_stop":
                    yield EndEvent(finish_reason="stop")
                    return
        yield EndEvent(finish_reason="stop")

    def _raise_for_status(self, resp) -> None:
        if 200 <= resp.status_code < 300:
            return
        try:
            body: Any = resp.json()
        except Exception:
            body = resp.text
        if resp.status_code == 401:
            raise ProviderAuthError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        if resp.status_code == 429:
            raise RateLimitError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        if resp.status_code == 400 and isinstance(body, dict):
            err = body.get("error") or {}
            if err.get("type") == "invalid_request_error" and "prompt is too long" in str(err.get("message", "")):
                raise ContextLengthError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        raise ProviderError(
            f"Anthropic request failed ({resp.status_code})",
            provider=self.provider,
            metadata={"status": resp.status_code, "body": body},
        )


def _split_system_message(messages: List[Dict[str, Any]]):
    system = None
    rest = []
    for message in messages:
        if message.get("role") == "system":
            system = message.get("content")
        elif message.get("role") == "tool":
            rest.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.get("tool_call_id"),
                            "content": message.get("content", ""),
                        }
                    ],
                }
            )
        elif message.get("role") == "assistant" and message.get("tool_calls"):
            blocks = []
            if message.get("content"):
                blocks.append({"type": "text", "text": message.get("content")})
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": call.get("id"),
                        "name": function.get("name"),
                        "input": json.loads(function.get("arguments", "{}")),
                    }
                )
            rest.append({"role": "assistant", "content": blocks})
        else:
            rest.append(message)
    return system, rest


def _to_anthropic_tool(tool: ToolSpec) -> Dict[str, Any]:
    return {
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.input_schema or {"type": "object", "properties": {}},
    }
