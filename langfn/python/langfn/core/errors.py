from __future__ import annotations

from typing import Any, Optional


class LangFnError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str,
        provider: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.code = code
        self.provider = provider
        self.metadata = metadata or {}


class ValidationError(LangFnError):
    def __init__(self, message: str = "Invalid request", **kwargs: Any):
        super().__init__(message, code="VALIDATION_ERROR", **kwargs)


class ProviderError(LangFnError):
    def __init__(self, message: str = "Provider request failed", **kwargs: Any):
        super().__init__(message, code="PROVIDER_ERROR", **kwargs)


class ProviderAuthError(LangFnError):
    def __init__(self, message: str = "Provider authentication failed", **kwargs: Any):
        super().__init__(message, code="PROVIDER_AUTH", **kwargs)


class RateLimitError(LangFnError):
    def __init__(
        self,
        message: str = "Provider rate limit exceeded",
        *,
        retry_after: Optional[float] = None,
        provider: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ):
        payload = {**(metadata or {})}
        if retry_after is not None:
            payload["retry_after"] = retry_after
        super().__init__(message, code="PROVIDER_RATE_LIMIT", provider=provider, metadata=payload)
        self.retry_after = retry_after


class TimeoutError(LangFnError):
    def __init__(self, message: str = "Provider request timed out", **kwargs: Any):
        super().__init__(message, code="PROVIDER_TIMEOUT", **kwargs)


class AbortError(LangFnError):
    def __init__(self, message: str = "Request cancelled", **kwargs: Any):
        super().__init__(message, code="ABORT", **kwargs)


class UnsupportedProviderError(LangFnError):
    def __init__(self, provider_name: str):
        super().__init__(
            f"Unsupported provider: {provider_name}",
            code="UNSUPPORTED_PROVIDER",
            metadata={"provider": provider_name},
        )


class ToolExecutionError(LangFnError):
    def __init__(self, message: str = "Tool execution failed", **kwargs: Any):
        super().__init__(message, code="TOOL_EXECUTION_ERROR", **kwargs)


class ToolSchemaError(LangFnError):
    def __init__(self, message: str = "Tool schema validation failed", **kwargs: Any):
        super().__init__(message, code="TOOL_SCHEMA_ERROR", **kwargs)


class ToolDisabledError(LangFnError):
    def __init__(self, message: str = "Tool is disabled", **kwargs: Any):
        super().__init__(message, code="TOOL_DISABLED", **kwargs)


class ToolPolicyViolationError(LangFnError):
    def __init__(self, message: str = "Tool policy violation", **kwargs: Any):
        super().__init__(message, code="TOOL_POLICY_VIOLATION", **kwargs)


class NotConfiguredError(LangFnError):
    def __init__(self, message: str = "Required configuration is missing", **kwargs: Any):
        super().__init__(message, code="NOT_CONFIGURED", **kwargs)


class InternalError(LangFnError):
    def __init__(self, message: str = "Internal error", **kwargs: Any):
        super().__init__(message, code="INTERNAL_ERROR", **kwargs)


class GraphMaxStepsError(LangFnError):
    def __init__(self, message: str = "Graph exceeded max steps", **kwargs: Any):
        super().__init__(message, code="GRAPH_MAX_STEPS", **kwargs)


class AgentMaxIterationsError(LangFnError):
    def __init__(self, message: str = "Agent exceeded max iterations", **kwargs: Any):
        super().__init__(message, code="AGENT_MAX_ITERATIONS", **kwargs)


class GraphInterruptError(LangFnError):
    def __init__(self, message: str = "Graph interrupted", **kwargs: Any):
        super().__init__(message, code="GRAPH_INTERRUPT", **kwargs)


class NonProductionBackendError(LangFnError):
    def __init__(self, message: str = "Backend is not approved for production retrieval", **kwargs: Any):
        super().__init__(message, code="NON_PRODUCTION_BACKEND", **kwargs)


class TraceNotFoundError(LangFnError):
    def __init__(self, message: str = "Trace not found", **kwargs: Any):
        super().__init__(message, code="TRACE_NOT_FOUND", **kwargs)


class SchemaValidationError(LangFnError):
    def __init__(self, message: str = "Schema validation failed", **kwargs: Any):
        super().__init__(message, code="SCHEMA_VALIDATION", **kwargs)


class ContextLengthError(LangFnError):
    def __init__(self, message: str = "Context length exceeded", **kwargs: Any):
        super().__init__(message, code="CONTEXT_LENGTH", **kwargs)


class MCPTransportError(LangFnError):
    def __init__(self, message: str = "MCP transport failed", **kwargs: Any):
        super().__init__(message, code="MCP_TRANSPORT_ERROR", **kwargs)


class MCPProtocolError(LangFnError):
    def __init__(self, message: str = "MCP protocol error", **kwargs: Any):
        super().__init__(message, code="MCP_PROTOCOL_ERROR", **kwargs)
