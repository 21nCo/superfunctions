from .core import Logger, create_logger
from .pipeline import (
    DEFAULT_SAMPLING_RATES,
    enrich_context,
    parse_w3c_trace_context,
    redact,
    sample,
    with_request_ids,
)
from .redact import (
    CIRCULAR,
    DEFAULT_PATTERNS,
    MAX_DEPTH,
    MAX_REDACTION_DEPTH,
    REDACTED,
    is_sensitive_key,
    redact_event,
)
from .sinks import DeliveryError, ResolverBusyError, SinkConsole, SinkHttp, Transport, stdlib_transport
from .types import (
    DEFAULT_VERSION,
    LOG_LEVEL_VALUES,
    MAX_EVENT_SIZE,
    MAX_TAGS,
    ErrorHandler,
    LogEvent,
    LogLevel,
    PipelineStage,
    Sink,
)
from .validation import (
    MAX_METADATA_CHARS,
    is_valid_log_event,
    sanitize_event,
    sanitize_value,
    validate_and_serialize,
)


def dev_logger(name: str = "app") -> Logger:
    """
    Create a development logger with pretty console output and debug level.
    """
    return create_logger(
        name=name,
        level="debug",
        sinks=[SinkConsole(json=False, color=True)],
    )


def server_logger(name: str, url: str | None = None, level: LogLevel = "info") -> Logger:
    """
    Create a server logger: redacted JSON console output, plus an HTTP sink
    only when a url is given.
    """
    sinks: list[Sink] = [SinkConsole(json=True, color=False)]
    if url:
        sinks.append(SinkHttp(url=url))

    return create_logger(
        name=name,
        level=level,
        pipeline=[redact()],
        sinks=sinks,
    )


__all__ = [
    "CIRCULAR",
    "DEFAULT_PATTERNS",
    "DEFAULT_SAMPLING_RATES",
    "DEFAULT_VERSION",
    "DeliveryError",
    "ErrorHandler",
    "LOG_LEVEL_VALUES",
    "LogEvent",
    "LogLevel",
    "Logger",
    "MAX_DEPTH",
    "MAX_EVENT_SIZE",
    "MAX_METADATA_CHARS",
    "MAX_REDACTION_DEPTH",
    "MAX_TAGS",
    "PipelineStage",
    "REDACTED",
    "ResolverBusyError",
    "Sink",
    "SinkConsole",
    "SinkHttp",
    "Transport",
    "create_logger",
    "dev_logger",
    "enrich_context",
    "is_sensitive_key",
    "is_valid_log_event",
    "parse_w3c_trace_context",
    "redact",
    "redact_event",
    "sample",
    "sanitize_event",
    "sanitize_value",
    "server_logger",
    "stdlib_transport",
    "validate_and_serialize",
    "with_request_ids",
]
