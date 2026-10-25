from typing import Optional

from .default_redaction import default_redactor
from .core import Logger, create_logger
from .pipeline import enrich_context, redact, sample, with_request_ids
from .sinks import SinkConsole, SinkHttp
from .types import (
    DefaultRedactionOptions,
    ErrorHandler,
    LogCorrelation,
    LogEvent,
    LogLevel,
    PipelineStage,
    Sink,
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

def server_logger(
    name: str,
    url: Optional[str] = None,
    level: LogLevel = "info"
) -> Logger:
    """
    Create a server logger with JSON output and optional HTTP sink.
    """
    sinks: list[Sink] = [SinkConsole(json=True, color=False)]
    if url:
        sinks.append(SinkHttp(url=url))
        
    return create_logger(
        name=name,
        level=level,
        sinks=sinks,
    )

__all__ = [
    "default_redactor",
    "DefaultRedactionOptions",
    "LogCorrelation",
    "ErrorHandler",
    "Logger",
    "create_logger",
    "dev_logger",
    "server_logger",
    "SinkConsole",
    "SinkHttp",
    "redact",
    "enrich_context",
    "sample",
    "with_request_ids",
    "LogLevel",
    "LogEvent",
    "Sink",
    "PipelineStage",
]
