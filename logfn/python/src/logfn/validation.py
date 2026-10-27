"""Sanitization and size limits applied after the pipeline."""

from __future__ import annotations

import json
import math
from datetime import date
from typing import Any, cast

from .redact import CIRCULAR, MAX_DEPTH, MAX_REDACTION_DEPTH, exception_message, format_exception_stack
from .types import MAX_EVENT_SIZE, MAX_TAGS, LogEvent

UNSERIALIZABLE = "[unserializable]"
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


def _byte_length(event: LogEvent) -> int:
    return len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace"))


def validate_and_serialize(event: LogEvent) -> tuple[LogEvent, bool]:
    """Sanitize an event and bound its UTF-8 size. Returns (event, truncated).
    An event over MAX_EVENT_SIZE loses its ctx and, if still too large, has
    its message shortened (then its tags removed)."""
    cleaned = cast(LogEvent, {key: value for key, value in event.items() if value is not None})
    cleaned["msg"] = str(event["msg"])
    if "ctx" in cleaned:
        cleaned["ctx"] = sanitize_value(cleaned["ctx"])
    if "tags" in cleaned:
        cleaned["tags"] = [str(tag) for tag in list(cleaned["tags"])[:MAX_TAGS]]

    original_size = _byte_length(cleaned)
    if original_size <= MAX_EVENT_SIZE:
        return cleaned, False

    cleaned["ctx"] = {"_truncated": True, "_reason": "size_limit", "_originalSize": original_size}
    overflow = _byte_length(cleaned) - MAX_EVENT_SIZE
    if overflow > 0:
        keep = max(0, len(cleaned["msg"]) - overflow - len(TRUNCATED_SUFFIX))
        cleaned["msg"] = cleaned["msg"][:keep] + TRUNCATED_SUFFIX
        if _byte_length(cleaned) > MAX_EVENT_SIZE:
            cleaned.pop("tags", None)
    return cleaned, True


def is_valid_log_event(event: Any) -> bool:
    """Whether a value has the required v0 fields as non-empty strings."""
    if not isinstance(event, dict):
        return False
    return all(isinstance(event.get(field), str) and event.get(field) for field in ("ts", "level", "msg", "name", "version"))
