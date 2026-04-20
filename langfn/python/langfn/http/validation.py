from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError as PydanticValidationError, model_validator
from superfunctions.auth import AuthSession
from superfunctions.http import RouteContext

from ..core.errors import LangFnError, ValidationError
from ..core.types import Message, TraceQuery


class CompleteBody(BaseModel):
    prompt: str
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_prompt(self) -> "CompleteBody":
        if not self.prompt.strip():
            raise ValueError("prompt must be a non-empty string")
        return self


class ChatBody(BaseModel):
    messages: List[Message]
    metadata: Dict[str, Any] = Field(default_factory=dict)
    tools: Optional[List[Any]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = Field(None, alias="tool_choice")

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="after")
    def validate_messages(self) -> "ChatBody":
        if not self.messages:
            raise ValueError("messages must be a non-empty array")
        return self


class StreamBody(BaseModel):
    prompt: Optional[str] = None
    messages: List[Message] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_source(self) -> "StreamBody":
        prompt = (self.prompt or "").strip()
        if prompt:
            self.prompt = prompt
            return self
        if self.messages:
            return self
        raise ValueError("stream request requires prompt or messages")


class EmbedBody(BaseModel):
    texts: Union[str, List[str]]

    @model_validator(mode="after")
    def validate_texts(self) -> "EmbedBody":
        if isinstance(self.texts, str):
            if not self.texts.strip():
                raise ValueError("texts must be non-empty")
            return self
        if not self.texts or any(not isinstance(item, str) or not item.strip() for item in self.texts):
            raise ValueError("texts must be a non-empty string or array of non-empty strings")
        return self


class FeedbackBody(BaseModel):
    trace_id: str = Field(alias="traceId")
    client_key: Optional[str] = Field(None, alias="clientKey")
    rating: float
    comment: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="before")
    @classmethod
    def normalize_aliases(cls, value: Any) -> Any:
        if isinstance(value, dict):
            data = dict(value)
            if "traceId" not in data and "trace_id" in data:
                data["traceId"] = data["trace_id"]
            if "clientKey" not in data and "client_key" in data:
                data["clientKey"] = data["client_key"]
            return data
        return value

    @model_validator(mode="after")
    def validate_trace(self) -> "FeedbackBody":
        if not self.trace_id.strip():
            raise ValueError("traceId must be a non-empty string")
        return self


class CanonicalTenantContext(BaseModel):
    tenant_id: Optional[str] = Field(None, alias="tenantId")
    user_id: Optional[str] = Field(None, alias="userId")
    run_id: Optional[str] = Field(None, alias="runId")
    conversation_id: Optional[str] = Field(None, alias="conversationId")

    model_config = ConfigDict(populate_by_name=True)


class LangFnRouteContext(RouteContext):
    auth: Optional[AuthSession] = None
    tenant_context: Optional[CanonicalTenantContext] = Field(None, alias="tenantContext")
    rate_limit: Optional[Dict[str, Any]] = Field(None, alias="rateLimit")

    model_config = ConfigDict(populate_by_name=True, arbitrary_types_allowed=True)

    def merge_metadata(
        self,
        metadata: Optional[Dict[str, Any]],
        *,
        client_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        tenant = self.tenant_context.model_dump(exclude_none=True, by_alias=True) if self.tenant_context else {}
        payload = {**(metadata or {}), **tenant}
        if client_key:
            payload["client_key"] = client_key
        return payload


def ensure_langfn_context(context: RouteContext) -> LangFnRouteContext:
    if isinstance(context, LangFnRouteContext):
        return context
    return LangFnRouteContext(
        params=context.params,
        query=context.query,
        headers=context.headers,
        url=context.url,
        method=context.method,
    )


def success_envelope(data: Dict[str, Any], trace_id: Optional[str] = None) -> Dict[str, Any]:
    return {
        "ok": True,
        "traceId": trace_id,
        "data": data,
        "error": None,
    }


def error_envelope(
    code: str,
    message: str,
    details: Optional[Dict[str, Any]] = None,
    trace_id: Optional[str] = None,
) -> Dict[str, Any]:
    payload = {
        "ok": False,
        "traceId": trace_id,
        "data": None,
        "error": {
            "code": code,
            "message": message,
        },
    }
    if details:
        payload["error"]["details"] = details
    return payload


def error_response(
    status: int,
    code: str,
    message: str,
    details: Optional[Dict[str, Any]] = None,
    trace_id: Optional[str] = None,
):
    from superfunctions.http import Response

    return Response(
        status=status,
        headers={"content-type": "application/json"},
        body=error_envelope(code, message, details, trace_id),
    )


def to_http_error(exc: Exception) -> tuple[int, str, str, Optional[Dict[str, Any]]]:
    if isinstance(exc, ValidationError):
        return 400, "VALIDATION_ERROR", str(exc), exc.metadata or None
    if isinstance(exc, LangFnError):
        return _status_for_code(exc.code), exc.code, str(exc), exc.metadata or None
    return 500, "INTERNAL_ERROR", str(exc), None


def parse_complete_body(value: Any) -> CompleteBody:
    return _validate_model(CompleteBody, value)


def parse_chat_body(value: Any) -> ChatBody:
    return _validate_model(ChatBody, value)


def parse_stream_body(value: Any) -> StreamBody:
    return _validate_model(StreamBody, value)


def parse_embed_body(value: Any) -> EmbedBody:
    return _validate_model(EmbedBody, value)


def parse_feedback_body(value: Any) -> FeedbackBody:
    return _validate_model(FeedbackBody, value)


def parse_traces_query(value: Dict[str, Any]) -> TraceQuery:
    payload = dict(value)
    if "limit" in payload:
        try:
            payload["limit"] = int(payload["limit"])
        except (TypeError, ValueError) as exc:
            raise ValidationError("limit must be an integer between 1 and 100") from exc
    query = _validate_model(TraceQuery, payload)
    if query.limit < 1 or query.limit > 100:
        raise ValidationError("limit must be an integer between 1 and 100")
    return query


def extract_tenant_context(request: Any, session: Optional[AuthSession] = None) -> CanonicalTenantContext:
    headers = _normalize_headers(getattr(request, "headers", {}))
    subject = session.subject if session is not None else None
    return CanonicalTenantContext(
        tenantId=headers.get("x-tenant-id") or (subject.tenant_id if subject is not None else None),
        userId=headers.get("x-user-id") or (subject.actor_id if subject is not None else None),
        runId=headers.get("x-run-id"),
        conversationId=headers.get("x-conversation-id"),
    )


def _validate_model(model: type[BaseModel], value: Any):
    try:
        return model.model_validate(value)
    except PydanticValidationError as exc:
        raise ValidationError("Invalid request body", metadata={"issues": exc.errors()}) from exc
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _normalize_headers(headers: Dict[str, Any]) -> Dict[str, str]:
    return {str(key).lower(): str(value) for key, value in headers.items()}


def _status_for_code(code: str) -> int:
    if code == "VALIDATION_ERROR":
        return 400
    if code == "PROVIDER_AUTH":
        return 401
    if code in {"RATE_LIMITED", "BUDGET_EXCEEDED", "PROVIDER_RATE_LIMIT"}:
        return 429
    return 500
