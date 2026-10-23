from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional

from ..core.errors import ContextLengthError, ProviderAuthError, ProviderError, RateLimitError
from ..tools.policy import resolve_secret
from ..core.types import (
    ChatRequest,
    ChatResponse,
    CompletionRequest,
    CompletionResponse,
    ContentEvent,
    EndEvent,
    Message,
    StreamEvent,
    ToolCall,
    ToolSpec,
    TokenUsage,
)
from ..utils.json import extract_first_json_object
from .base import ChatModel
from .transport import get_async_client


@dataclass
class OpenAIChatModel(ChatModel):
    api_key: str = ""
    api_key_ref: Optional[str] = None
    model: str = "gpt-4o-mini"
    base_url: str = "https://api.openai.com/v1"
    timeout: float = 60.0
    organization: Optional[str] = None
    project: Optional[str] = None
    secret_provider: Optional[Any] = None
    transport: Optional[Any] = None
    provider: str = "openai"

    def _client(self):
        api_key = self.api_key or resolve_secret(self.api_key_ref, self.secret_provider)
        headers = {"authorization": f"Bearer {api_key or ''}", "content-type": "application/json"}
        if self.organization:
            headers["openai-organization"] = self.organization
        if self.project:
            headers["openai-project"] = self.project
        return get_async_client(base_url=self.base_url, headers=headers, timeout=self.timeout, transport=self.transport)

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        return await self._complete_from_chat(request)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        payload: Dict[str, Any] = {"model": self.model, "messages": request.messages}
        if request.tools:
            payload["tools"] = [_to_openai_tool(t) for t in request.tools]
        if request.tool_choice is not None:
            payload["tool_choice"] = request.tool_choice
        resp = await self._client().post("/chat/completions", json=payload)
        self._raise_for_status(resp)

        data = resp.json()
        message = ((data.get("choices") or [{}])[0]).get("message") or {}
        tool_calls = _parse_openai_tool_calls(message.get("tool_calls"))
        usage = data.get("usage") or {}
        token_usage = TokenUsage.from_counts(
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
        )
        return ChatResponse(
            message=Message(role="assistant", content=message.get("content") or ""),
            tool_calls=tool_calls,
            raw=data,
            usage=token_usage,
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": request.prompt}],
            "stream": True,
        }
        async with self._client().stream("POST", "/chat/completions", json=payload) as resp:
            self._raise_for_status(resp)
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                chunk = line[len("data:") :].strip()
                if chunk == "[DONE]":
                    yield EndEvent(finish_reason="stop")
                    return
                try:
                    data = json.loads(chunk)
                except json.JSONDecodeError:
                    candidate = extract_first_json_object(chunk)
                    if candidate is None:
                        continue
                    data = json.loads(candidate)
                choice = (data.get("choices") or [{}])[0]
                delta = (choice.get("delta") or {}).get("content")
                if delta:
                    yield ContentEvent(content=delta, delta=delta)
        yield EndEvent(finish_reason="stop")

    def _raise_for_status(self, resp) -> None:
        if 200 <= resp.status_code < 300:
            return
        retry_after = resp.headers.get("retry-after")
        try:
            body: Any = resp.json()
        except Exception:
            body = resp.text
        if resp.status_code == 401:
            raise ProviderAuthError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        if resp.status_code == 429:
            raise RateLimitError(
                provider=self.provider,
                retry_after=float(retry_after) if retry_after is not None else None,
                metadata={"status": resp.status_code, "body": body},
            )
        if resp.status_code == 400 and isinstance(body, dict):
            err = body.get("error") or {}
            code = err.get("code") or err.get("type")
            if code in {"context_length_exceeded", "invalid_request_error"} and "maximum context length" in str(err.get("message", "")).lower():
                raise ContextLengthError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        raise ProviderError(
            f"OpenAI request failed ({resp.status_code})",
            provider=self.provider,
            metadata={"status": resp.status_code, "body": body},
        )


def _to_openai_tool(tool: ToolSpec) -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema or {"type": "object", "properties": {}},
        },
    }


def _parse_openai_tool_calls(raw: Any) -> Optional[List[ToolCall]]:
    if not raw:
        return None
    calls: List[ToolCall] = []
    for c in raw:
        fn = (c or {}).get("function") or {}
        name = fn.get("name")
        args_raw = fn.get("arguments") or "{}"
        try:
            arguments = json.loads(args_raw) if isinstance(args_raw, str) else dict(args_raw)
        except Exception:
            arguments = {}
        if not name:
            continue
        calls.append(ToolCall(id=str(c.get("id") or ""), name=name, arguments=arguments))
    return calls or None
