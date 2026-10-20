import sys
from typing import Any, Dict, List, Literal, Optional, Protocol, Union, Callable, runtime_checkable

if sys.version_info >= (3, 11):
    from typing import NotRequired, TypedDict
else:
    from typing_extensions import NotRequired, TypedDict


LogLevel = Literal["trace", "debug", "info", "warn", "error", "fatal"]

LOG_LEVEL_VALUES: Dict[LogLevel, int] = {
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
    ctx: NotRequired[Dict[str, Any]]
    tags: NotRequired[List[str]]
    traceId: NotRequired[str]
    spanId: NotRequired[str]
    requestId: NotRequired[str]
    userId: NotRequired[str]
    tenantId: NotRequired[str]
    version: str

ErrorHandler = Callable[[BaseException, Dict[str, str]], None]

PipelineStage = Callable[[LogEvent], Optional[LogEvent]]

@runtime_checkable
class Sink(Protocol):
    def __call__(self, batch: List[LogEvent]) -> Any:
        ...
    
    # flush is optional in TS but Protocol doesn't support optional methods well.
    # We can check with hasattr at runtime.
    # But defining it here implies it should exist.
    # For now, we will define it, but users might not implement it.
    # Alternatively, we just use typing.Callable for the main part and check for flush attribute.
    # But a Protocol class is cleaner. We can make flush return Awaitable or None.
    async def flush(self) -> None:
        ...

class DefaultRedactionOptions(TypedDict, total=False):
    allowlist: List[str]


class LoggerOptions(TypedDict):
    redaction: NotRequired[DefaultRedactionOptions]
    correlation: NotRequired[LogCorrelation]
    onError: NotRequired[ErrorHandler]
    name: str
    level: NotRequired[LogLevel]
    pipeline: NotRequired[List[PipelineStage]]
    sinks: List[Sink]
    now: NotRequired[Callable[[], Any]] # returns datetime or similar
    baseContext: NotRequired[Dict[str, Any]]
    baseTags: NotRequired[List[str]]

class ChildLoggerOptions(TypedDict):
    correlation: NotRequired[LogCorrelation]
    name: NotRequired[str]
    level: NotRequired[LogLevel]
    ctx: NotRequired[Dict[str, Any]]
    tags: NotRequired[List[str]]
