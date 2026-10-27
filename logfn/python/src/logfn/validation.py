"""Sanitization and size limits applied after the pipeline."""

from __future__ import annotations

import json
import math
from datetime import date
from typing import Any, cast

from .redact import (
    CIRCULAR,
    MAX_DEPTH,
    MAX_REDACTION_DEPTH,
    UNSERIALIZABLE,
    exception_message,
    format_exception_stack,
)
from .types import MAX_EVENT_SIZE, MAX_TAGS, LogEvent

TRUNCATED_SUFFIX = "...[truncated]"


def _sanitize(value: Any, ancestors: set[int], depth: int) -> Any:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        # Same text as JavaScript's String(NaN) and String(Infinity).
        return "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
    if isinstance(value, date):
        return value.isoformat()
    if not isinstance(value, (dict, list, tuple, set, frozenset, BaseException)):
        return UNSERIALIZABLE

    identity = id(value)
    if identity in ancestors:
        return CIRCULAR
    if depth >= MAX_REDACTION_DEPTH:
        return MAX_DEPTH

    ancestors.add(identity)
    try:
        if isinstance(value, BaseException):
            error: dict[str, Any] = {
                "name": type(value).__name__,
                "message": exception_message(value),
                "stack": format_exception_stack(value),
            }
            if value.__cause__ is not None:
                error["cause"] = _sanitize(value.__cause__, ancestors, depth + 1)
            return error
        if isinstance(value, dict):
            return {str(key): _sanitize(item, ancestors, depth + 1) for key, item in value.items()}
        return [_sanitize(item, ancestors, depth + 1) for item in value]
    finally:
        ancestors.discard(identity)


def sanitize_value(value: Any) -> Any:
    """Return a JSON-safe copy: unknown objects become "[unserializable]",
    dates ISO strings, exceptions {name, message, stack, cause}, non-finite
    floats their JavaScript spelling and cycles "[circular]"."""
    return _sanitize(value, set(), 0)


# Longest kept string for a metadata field once an event is over the size limit
MAX_METADATA_CHARS = 256

_METADATA_FIELDS = ("ts", "level", "name", "version", "traceId", "spanId", "requestId", "userId", "tenantId")


def _unserializable(_value: object) -> str:
    return UNSERIALIZABLE


def json_bytes(value: Any) -> bytes:
    """Compact UTF-8 JSON, the encoding both measured by the size limit and
    sent by SinkHttp. Non-ASCII text is not escaped, so a measured event is
    never larger on the wire."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=_unserializable).encode(
        "utf-8", "replace"
    )


def _byte_length(event: Any) -> int:
    return len(json_bytes(event))


def _tag_text(tag: Any) -> str:
    if isinstance(tag, str):
        return tag
    return json.dumps(sanitize_value(tag), ensure_ascii=False, separators=(",", ":"))


def sanitize_event(event: LogEvent) -> LogEvent:
    """Return a JSON-safe copy of every field of an event: msg becomes a
    string, tags (at most MAX_TAGS) strings, and every other field is
    sanitized like ctx. None fields are removed."""
    sanitized: dict[str, Any] = {}
    for raw_key, value in event.items():
        if value is None:
            continue
        key = str(raw_key)
        if key == "msg":
            sanitized[key] = str(value)
        elif key == "tags" and isinstance(value, (list, tuple)):
            sanitized[key] = [_tag_text(tag) for tag in list(value)[:MAX_TAGS]]
        else:
            sanitized[key] = sanitize_value(value)
    sanitized.setdefault("msg", "")
    return cast(LogEvent, sanitized)


def _truncate(text: str, keep: int) -> str:
    return text[: max(0, keep)] + TRUNCATED_SUFFIX


def _bound_metadata(event: dict[str, Any]) -> dict[str, Any]:
    # Schema metadata only, as strings of at most MAX_METADATA_CHARS; fields
    # outside the schema and non-string metadata are removed.
    bounded: dict[str, Any] = {"msg": event["msg"], "ctx": event["ctx"]}
    if "tags" in event:
        bounded["tags"] = event["tags"]
    for field in _METADATA_FIELDS:
        value = event.get(field)
        if not isinstance(value, str):
            continue
        if len(value) > MAX_METADATA_CHARS:
            value = _truncate(value, MAX_METADATA_CHARS - len(TRUNCATED_SUFFIX))
        bounded[field] = value
    return bounded


def validate_and_serialize(event: LogEvent) -> tuple[LogEvent, bool]:
    """Sanitize an event and bound its size. Returns (event, truncated).

    The result is always at most MAX_EVENT_SIZE bytes of UTF-8 JSON. An event
    over the limit loses its ctx (replaced by a truncation marker). If the
    fields other than msg still take more than half the limit, metadata is
    cut to the schema fields of at most MAX_METADATA_CHARS characters each,
    then the tags are removed. Finally the message is shortened to fit."""
    cleaned: dict[str, Any] = dict(sanitize_event(event))
    original_size = _byte_length(cleaned)
    if original_size <= MAX_EVENT_SIZE:
        return cast(LogEvent, cleaned), False

    cleaned["ctx"] = {"_truncated": True, "_reason": "size_limit", "_originalSize": original_size}

    def without_message() -> int:
        return _byte_length({**cleaned, "msg": ""})

    if without_message() > MAX_EVENT_SIZE // 2:
        cleaned = _bound_metadata(cleaned)
        if without_message() > MAX_EVENT_SIZE // 2:
            cleaned.pop("tags", None)
    overflow = _byte_length(cleaned) - MAX_EVENT_SIZE
    if overflow > 0:
        # Every removed character frees at least one byte, and the other
        # fields take at most half the limit, so this fits.
        message = cleaned["msg"]
        cleaned["msg"] = _truncate(message, len(message) - overflow - len(TRUNCATED_SUFFIX))
    return cast(LogEvent, cleaned), True


def is_valid_log_event(event: Any) -> bool:
    """Whether a value has the required v0 fields as non-empty strings."""
    if not isinstance(event, dict):
        return False
    return all(isinstance(event.get(field), str) and event.get(field) for field in ("ts", "level", "msg", "name", "version"))
