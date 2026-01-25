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


class RateLimitError(LangFnError):
    def __init__(
        self,
        *,
        retry_after: Optional[float] = None,
        provider: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ):
        super().__init__(
            "Rate limit exceeded",
            code="RATE_LIMIT",
            provider=provider,
            metadata={**(metadata or {}), "retry_after": retry_after},
        )
        self.retry_after = retry_after


class ProviderAuthError(LangFnError):
    def __init__(self, message: str = "Provider authentication failed", **kwargs: Any):
        super().__init__(message, code="PROVIDER_AUTH", **kwargs)


class ToolExecutionError(LangFnError):
    def __init__(self, message: str = "Tool execution failed", **kwargs: Any):
        super().__init__(message, code="TOOL_EXECUTION", **kwargs)


class SchemaValidationError(LangFnError):
    def __init__(self, message: str = "Schema validation failed", **kwargs: Any):
        super().__init__(message, code="SCHEMA_VALIDATION", **kwargs)


class TimeoutError(LangFnError):
    def __init__(self, message: str = "Request timed out", **kwargs: Any):
        super().__init__(message, code="TIMEOUT", **kwargs)


class ContextLengthError(LangFnError):
    def __init__(self, message: str = "Context length exceeded", **kwargs: Any):
        super().__init__(message, code="CONTEXT_LENGTH", **kwargs)


class AbortError(LangFnError):
    def __init__(self, message: str = "Request cancelled", **kwargs: Any):
        super().__init__(message, code="ABORT", **kwargs)

