from collections.abc import Callable
from typing import Any, Literal, Protocol, TypedDict

LogLevel = Literal["trace", "debug", "info", "warn", "error", "fatal"]

LOG_LEVEL_VALUES: dict[LogLevel, int] = {
    "trace": 0,
    "debug": 1,
    "info": 2,
    "warn": 3,
    "error": 4,
    "fatal": 5,
}

DEFAULT_VERSION = "0"

# Maximum event size in UTF-8 bytes after serialization
MAX_EVENT_SIZE = 64 * 1024

# Maximum number of tags per event
MAX_TAGS = 20


class _LogEventRequired(TypedDict):
    ts: str  # RFC3339 timestamp with milliseconds
    level: LogLevel
    msg: str
    name: str
    version: str


class LogEvent(_LogEventRequired, total=False):
    ctx: dict[str, Any]
    tags: list[str]
    traceId: str
    spanId: str
    requestId: str
    userId: str
    tenantId: str


PipelineStage = Callable[[LogEvent], LogEvent | None]


class Sink(Protocol):
    """Receives batches of events. A sink may also define ``flush()``
    (sync or async); the logger checks for it at runtime.

    Loggers pass JSON-safe events that are not size-bounded, so that a sink
    which redacts (SinkHttp) does so before any truncation; a sink that needs
    the MAX_EVENT_SIZE bound applies ``validate_and_serialize`` itself, after
    its own redaction. Both built-in sinks do."""

    def __call__(self, batch: list[LogEvent]) -> Any: ...


ErrorHandler = Callable[[BaseException, dict[str, str]], None]


class RedactionOptions(TypedDict, total=False):
    patterns: list[Any]
    allowlist: list[str]
    keys: list[str]
    replacement: str


class ChildLoggerOptions(TypedDict, total=False):
    name: str
    level: LogLevel
    ctx: dict[str, Any]
    tags: list[str]
