from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, computed_field


Role = Literal["system", "user", "assistant", "tool"]


class TokenUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @computed_field(return_type=int)
    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @classmethod
    def from_counts(cls, prompt_tokens: int = 0, completion_tokens: int = 0) -> "TokenUsage":
        return cls(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )


class Cost(BaseModel):
    input: float = 0.0
    output: float = 0.0
    total: float = 0.0


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: Dict[str, Any] = Field(default_factory=dict)


class ToolSpec(BaseModel):
    name: str
    description: str
    input_schema: Dict[str, Any] = Field(default_factory=dict)


class Message(BaseModel):
    role: Role
    content: str
    name: Optional[str] = None
    tool_call_id: Optional[str] = None


class CompletionRequest(BaseModel):
    prompt: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class CompletionResponse(BaseModel):
    content: str
    raw: Optional[Any] = None
    usage: Optional[TokenUsage] = None
    cost: Optional[Cost] = None
    trace_id: Optional[str] = None
    parsed: Optional[Any] = None


class ChatRequest(BaseModel):
    messages: List[Dict[str, Any]]
    metadata: Dict[str, Any] = Field(default_factory=dict)
    tools: Optional[List[ToolSpec]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None


class ChatResponse(BaseModel):
    message: Message
    tool_calls: Optional[List[ToolCall]] = None
    raw: Optional[Any] = None
    usage: Optional[TokenUsage] = None
    cost: Optional[Cost] = None
    trace_id: Optional[str] = None
    parsed: Optional[Any] = None


class BatchRequest(BaseModel):
    prompt: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class BatchError(BaseModel):
    code: str
    message: str


class BatchResult(BaseModel):
    ok: bool
    index: int
    content: Optional[str] = None
    trace_id: Optional[str] = None
    response: Optional[CompletionResponse] = None
    error: Optional[BatchError] = None


class FeedbackRequest(BaseModel):
    trace_id: str
    client_key: Optional[str] = None
    rating: float
    comment: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class TraceQuery(BaseModel):
    limit: int = 10
    provider: Optional[str] = None
    model: Optional[str] = None


class ContentEvent(BaseModel):
    type: Literal["content"] = "content"
    content: str
    delta: str = ""
    trace_id: Optional[str] = None


class ToolCallEvent(BaseModel):
    type: Literal["tool_call"] = "tool_call"
    tool_name: str
    args: Dict[str, Any] = Field(default_factory=dict)
    id: str
    trace_id: Optional[str] = None


class ToolResultEvent(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_call_id: str
    result: Any
    trace_id: Optional[str] = None


class TokenUsageEvent(BaseModel):
    type: Literal["token_usage"] = "token_usage"
    prompt_tokens: int
    completion_tokens: int
    trace_id: Optional[str] = None


class TraceEvent(BaseModel):
    type: Literal["trace_event"] = "trace_event"
    span: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    trace_id: Optional[str] = None


class ReasoningEvent(BaseModel):
    type: Literal["reasoning"] = "reasoning"
    step: str
    thinking: str
    trace_id: Optional[str] = None


class EndEvent(BaseModel):
    type: Literal["end"] = "end"
    finish_reason: str = "stop"
    trace_id: Optional[str] = None


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    error: Any
    trace_id: Optional[str] = None


StreamEvent = Union[
    ContentEvent,
    ToolCallEvent,
    ToolResultEvent,
    TokenUsageEvent,
    TraceEvent,
    ReasoningEvent,
    EndEvent,
    ErrorEvent,
]
