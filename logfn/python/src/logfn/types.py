import sys
from typing import Any, Callable, Literal, Optional, Protocol, runtime_checkable

if sys.version_info >= (3, 11):
    from typing import NotRequired, TypedDict
else:
    from typing_extensions import NotRequired, TypedDict


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

class LogCorrelation(TypedDict, total=False):
    traceId: str
    spanId: str
    requestId: str
    userId: str
    tenantId: str


class LogEvent(TypedDict):
    ts: str  # ISO8601 timestamp
    level: LogLevel
    msg: str
    name: str
    ctx: NotRequired[dict[str, Any]]
    tags: NotRequired[list[str]]
    traceId: NotRequired[str]
    spanId: NotRequired[str]
    requestId: NotRequired[str]
    userId: NotRequired[str]
    tenantId: NotRequired[str]
    version: str

ErrorHandler = Callable[[BaseException, dict[str, str]], None]

PipelineStage = Callable[[LogEvent], Optional[LogEvent]]

@runtime_checkable
class Sink(Protocol):
    """Callable sink; a runtime-discovered flush hook is optional."""

    def __call__(self, batch: list[LogEvent], /) -> Any:
        ...

class DefaultRedactionOptions(TypedDict, total=False):
    allowlist: list[str]


class LoggerOptions(TypedDict):
    redaction: NotRequired[DefaultRedactionOptions]
    correlation: NotRequired[LogCorrelation]
    onError: NotRequired[ErrorHandler]
    name: str
    level: NotRequired[LogLevel]
    pipeline: NotRequired[list[PipelineStage]]
    sinks: list[Sink]
    now: NotRequired[Callable[[], Any]] # returns datetime or similar
    baseContext: NotRequired[dict[str, Any]]
    baseTags: NotRequired[list[str]]

class ChildLoggerOptions(TypedDict):
    correlation: NotRequired[LogCorrelation]
    name: NotRequired[str]
    level: NotRequired[LogLevel]
    ctx: NotRequired[dict[str, Any]]
    tags: NotRequired[list[str]]
