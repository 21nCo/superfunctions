from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional, Sequence

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
    ToolCall,
    ToolSpec,
    TokenUsage,
)
from ..utils.json import extract_first_json_object
from .base import ChatModel


@dataclass
class OpenAIChatModel(ChatModel):
    api_key: str
    model: str = "gpt-4o-mini"
    base_url: str = "https://api.openai.com/v1"
    timeout: float = 60.0
    organization: Optional[str] = None
    project: Optional[str] = None
    transport: Optional[Any] = None

    provider: str = "openai"

    def _client(self) -> httpx.AsyncClient:
        headers = {"authorization": f"Bearer {self.api_key}"}
        if self.organization:
            headers["openai-organization"] = self.organization
        if self.project:
            headers["openai-project"] = self.project
        return httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            transport=self.transport,
        )

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        chat_request = ChatRequest(messages=[{"role": "user", "content": request.prompt}], metadata=request.metadata)
        chat_resp = await self.chat(chat_request)
        usage = chat_resp.usage
        return CompletionResponse(
            content=chat_resp.message.content,
            raw=chat_resp.raw,
            usage=usage,
        )

    async def chat(self, request: ChatRequest) -> ChatResponse:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": request.messages,
        }
        if request.tools:
            payload["tools"] = [_to_openai_tool(t) for t in request.tools]
        if request.tool_choice is not None:
            payload["tool_choice"] = request.tool_choice
        async with self._client() as client:
            resp = await client.post("/chat/completions", json=payload)
        self._raise_for_status(resp)

        data = resp.json()
        message = data["choices"][0]["message"]
        tool_calls = _parse_openai_tool_calls(message.get("tool_calls"))
        usage = data.get("usage")
        token_usage = None
        if isinstance(usage, dict):
            token_usage = TokenUsage(
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
        async with self._client() as client:
            async with client.stream("POST", "/chat/completions", json=payload) as resp:
                self._raise_for_status(resp)
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    if not line.startswith("data:"):
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

    def _raise_for_status(self, resp: httpx.Response) -> None:
        if 200 <= resp.status_code < 300:
            return

        retry_after = resp.headers.get("retry-after")
        body: Any = None
        try:
            body = resp.json()
        except Exception:
            body = resp.text

        if resp.status_code == 401:
            raise ProviderAuthError(metadata={"status": resp.status_code, "body": body}, provider=self.provider)
        if resp.status_code == 429:
            ra = float(retry_after) if retry_after is not None else None
            raise RateLimitError(retry_after=ra, provider=self.provider, metadata={"status": resp.status_code, "body": body})
        if resp.status_code == 400 and isinstance(body, dict):
            err = body.get("error") or {}
            code = err.get("code") or err.get("type")
            if code in {"context_length_exceeded", "invalid_request_error"} and "maximum context length" in str(
                err.get("message", "")
            ).lower():
                raise ContextLengthError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        raise LangFnError(
            f"OpenAI request failed ({resp.status_code})",
            code="PROVIDER_ERROR",
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
        args: Dict[str, Any]
        try:
            args = json.loads(args_raw) if isinstance(args_raw, str) else dict(args_raw)
        except Exception:
            args = {}
        if not name:
            continue
        calls.append(ToolCall(id=str(c.get("id") or ""), name=name, arguments=args))
    return calls or None
