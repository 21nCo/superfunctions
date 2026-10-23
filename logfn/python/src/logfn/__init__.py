from typing import Optional, List

from .core import Logger, create_logger
from .pipeline import redact, enrich_context, sample, with_request_ids
from .sinks import SinkConsole, SinkHttp
from .types import LogLevel, LogEvent, Sink, PipelineStage

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
    sinks: List[Sink] = [SinkConsole(json=True, color=False)]
    if url:
        sinks.append(SinkHttp(url=url))
        
    return create_logger(
        name=name,
        level=level,
        sinks=sinks,
    )

__all__ = [
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
