from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, AsyncIterator

from ..core.errors import ValidationError
from ..core.types import (
    ContentEvent,
    EndEvent,
    ErrorEvent,
    ReasoningEvent,
    StreamEvent,
    TokenUsageEvent,
    ToolCallEvent,
    ToolResultEvent,
    TraceEvent,
)

if TYPE_CHECKING:
    from ..client import LangFn


def normalize_stream_event(event: Any, trace_id: str) -> StreamEvent:
    raw = event.model_dump() if hasattr(event, "model_dump") else dict(event)
    kind = raw.get("type")
    if kind == "content":
        return ContentEvent(
            content=str(raw.get("content") or raw.get("delta") or ""),
            delta=str(raw.get("delta") or raw.get("content") or ""),
            trace_id=trace_id,
        )
    if kind == "tool_call":
        return ToolCallEvent(
            id=str(raw.get("id") or ""),
            tool_name=str(raw.get("tool_name") or raw.get("toolName") or ""),
            args=dict(raw.get("args") or {}),
            trace_id=trace_id,
        )
    if kind == "tool_result":
        return ToolResultEvent(
            tool_call_id=str(raw.get("tool_call_id") or raw.get("toolCallId") or ""),
            result=raw.get("result"),
            trace_id=trace_id,
        )
    if kind == "token_usage":
        return TokenUsageEvent(
            prompt_tokens=int(raw.get("prompt_tokens") or raw.get("promptTokens") or 0),
            completion_tokens=int(raw.get("completion_tokens") or raw.get("completionTokens") or 0),
            trace_id=trace_id,
        )
    if kind == "trace_event":
        return TraceEvent(
            span=str(raw.get("span") or ""),
            metadata=dict(raw.get("metadata") or {}),
            trace_id=trace_id,
        )
    if kind == "reasoning":
        return ReasoningEvent(
            step=str(raw.get("step") or ""),
            thinking=str(raw.get("thinking") or ""),
            trace_id=trace_id,
        )
    if kind == "end":
        return EndEvent(finish_reason=str(raw.get("finish_reason") or "stop"), trace_id=trace_id)
    if kind == "error":
        return ErrorEvent(error=raw.get("error"), trace_id=trace_id)
    raise ValidationError(f"Unsupported stream event type: {kind}")


async def normalize_stream(stream: AsyncIterator[Any], trace_id: str) -> AsyncIterator[StreamEvent]:
    terminal_seen = False
    async for event in stream:
        if terminal_seen:
            raise ValidationError("Stream emitted events after a terminal event")
        normalized = normalize_stream_event(event, trace_id)
        yield normalized
        if normalized.type in {"end", "error"}:
            terminal_seen = True
            return
    if not terminal_seen:
        yield EndEvent(finish_reason="stop", trace_id=trace_id)


def to_sse_frame(event: StreamEvent) -> str:
    return f"data: {json.dumps(event.model_dump(exclude_none=True))}\n\n"


async def to_sse(lang: LangFn, prompt: str) -> AsyncIterator[str]:
    async for event in lang.stream(prompt):
        yield to_sse_frame(event)
