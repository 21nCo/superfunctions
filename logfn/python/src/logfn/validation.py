"""Sanitization and size limits applied after the pipeline."""

from __future__ import annotations

import json
import math
from datetime import date, datetime
from typing import Any, cast

from .redact import (
    CIRCULAR,
    MAX_DEPTH,
    MAX_REDACTION_DEPTH,
    MAX_SIZE,
    UNSERIALIZABLE,
    exception_message,
    format_exception_stack,
    unique_key,
)
from .types import LOG_LEVEL_VALUES, MAX_EVENT_SIZE, MAX_TAGS, LogEvent

TRUNCATED_SUFFIX = "...[truncated]"

# Values plus string and key characters one walk copies, each charged first;
# past it values are MAX_SIZE, so shared objects cannot expand to 2^depth copies.
MAX_TRAVERSAL = 4 * MAX_EVENT_SIZE


class _Budget:
    # One walk's budget, passed down rather than global, so walks on other
    # threads or started by caller code inside a walk keep their own.
    __slots__ = ("left",)

    def __init__(self) -> None:
        self.left = MAX_TRAVERSAL

    def charge(self, cost: int) -> bool:
        self.left -= cost
        return self.left >= 0


def _sanitize(value: Any, ancestors: set[int], depth: int, budget: _Budget) -> Any:
    if not budget.charge(len(value) + 1 if isinstance(value, str) else 1):
        return MAX_SIZE
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        # Same text as JavaScript's String(NaN) and String(Infinity).
        return "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
    if isinstance(value, date):
        # The built-in method, so a subclass override cannot add text.
        text = datetime.isoformat(value) if isinstance(value, datetime) else date.isoformat(value)
        return _sanitize(text, ancestors, depth, budget)
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
            message = exception_message(value)
            error: dict[str, Any] = {
                "name": _sanitize(type(value).__name__, ancestors, depth + 1, budget),
                "message": _sanitize(message, ancestors, depth + 1, budget),
            }
            # The stack repeats the message: past the budget it is charged as that, never built.
            fits = budget.left > len(message) or budget.charge(len(message) + 1)
            error["stack"] = _sanitize(format_exception_stack(value, message), ancestors, depth + 1, budget) if fits else MAX_SIZE
            chained = value.__cause__ if value.__cause__ is not None or value.__suppress_context__ else value.__context__
            if chained is not None:
                error["cause"] = _sanitize(chained, ancestors, depth + 1, budget)
            return error
        if isinstance(value, dict):
            result: dict[str, Any] = {}
            used: dict[str, int] = {}
            for key, item in value.items():
                text = str(key)
                # A value is read only after its key is charged, so none is copied past the budget.
                if not budget.charge(len(text)):
                    break
                # 1 and "1" are both "1" in JSON: the later one is kept as "1#2".
                result[unique_key(result, text, used)] = _sanitize(item, ancestors, depth + 1, budget)
            return result
        items: list[Any] = []
        for item in value:
            if budget.left < 0:
                break
            items.append(_sanitize(item, ancestors, depth + 1, budget))
        return items
    finally:
        ancestors.discard(identity)


def sanitize_value(value: Any) -> Any:
    """Return a JSON-safe copy: unknown objects become "[unserializable]",
    dates ISO strings, exceptions {name, message, stack, cause}, non-finite
    floats their JavaScript spelling and cycles "[circular]". Values past
    MAX_TRAVERSAL become "[max-size]"."""
    return _sanitize(value, set(), 0, _Budget())


# Longest kept string for a metadata field once an event is over the size limit
MAX_METADATA_CHARS = 256

_METADATA_FIELDS = ("ts", "level", "name", "version", "traceId", "spanId", "requestId", "userId", "tenantId")
_SCHEMA_ORDER = ("msg", "tags", "ctx", *_METADATA_FIELDS)
# The schema fields. Walked on their own budget, so no other field can turn
# ctx, level or an id into MAX_SIZE, and no other field takes their names.
SCHEMA_FIELDS = frozenset(_SCHEMA_ORDER)


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
    # Numbers and booleans as JavaScript writes them; any other value, an
    # object above all, has no text a sink could redact by its keys.
    if isinstance(tag, str):
        return tag
    if isinstance(tag, bool):
        return "true" if tag else "false"
    if isinstance(tag, int):
        return str(tag)
    if isinstance(tag, float):
        if not math.isfinite(tag):
            return cast(str, sanitize_value(tag))
        return _js_number(tag)
    return UNSERIALIZABLE


def _js_number(value: float) -> str:
    # ECMAScript Number::toString: the shortest round-trip digits (repr's),
    # in decimal notation for exponents -7 < n <= 21, else d.ddde+N / e-N.
    # Read from repr's text alone, so no decimal context can change it.
    if value == 0:
        return "0"
    mantissa, _, exp = repr(abs(value)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    significant = (whole + fraction).lstrip("0")
    digits = significant.rstrip("0")
    k = len(digits)
    n = int(exp or 0) - len(fraction) + len(significant)
    if k <= n <= 21:
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:
        text = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        text = "0." + "0" * -n + digits
    else:
        text = digits[0] + (f".{digits[1:]}" if k > 1 else "") + ("e+" if n > 0 else "e-") + str(abs(n - 1))
    return ("-" if value < 0 else "") + text


def sanitize_event(event: LogEvent) -> LogEvent:
    """Return a JSON-safe copy of every field of an event: msg becomes a
    string, tags (at most MAX_TAGS) strings, and every other field is
    sanitized like ctx. None fields are removed. Fields outside the schema
    share one budget; once it is spent the walk over the keys stops, the
    rest are dropped unread and the schema fields not reached yet follow in
    schema order."""
    sanitized: dict[str, Any] = {}
    used: dict[str, int] = {}
    shared = _Budget()

    def copy(key: str, value: Any, budget: _Budget) -> None:
        if value is None:
            return
        if key == "msg":
            sanitized[key] = str(value)
        elif key == "tags" and isinstance(value, (list, tuple)):
            tags = _Budget()
            sanitized[key] = [_sanitize(_tag_text(tag), set(), 0, tags) for tag in list(value[:MAX_TAGS])]
        else:
            sanitized[key] = _sanitize(value, set(), 0, budget)

    stopped = False
    for raw_key, value in event.items():
        if isinstance(raw_key, str) and raw_key in SCHEMA_FIELDS:
            copy(raw_key, value, _Budget())
            continue
        key = str(raw_key)
        stopped = not shared.charge(len(key))
        if not stopped:
            copy(unique_key(sanitized, key, used, SCHEMA_FIELDS), value, shared)
            stopped = shared.left < 0
        if stopped:
            break
    # No per-key work past the shared budget: only the schema fields, by name.
    for key in _SCHEMA_ORDER if stopped else ():
        if key not in sanitized:
            copy(key, event.get(key), _Budget())
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


_OPTIONAL_STRING_FIELDS = ("traceId", "spanId", "requestId", "userId", "tenantId")


def is_valid_log_event(event: Any) -> bool:
    """Whether a value is a v0 event: non-empty ts, name and version strings,
    a known level, a string msg (possibly empty), and, when present, string
    ids, a dict ctx and a list of string tags."""
    if not isinstance(event, dict):
        return False
    if not all(isinstance(event.get(field), str) and event.get(field) for field in ("ts", "name", "version")):
        return False
    level = event.get("level")
    if not isinstance(level, str) or level not in LOG_LEVEL_VALUES or not isinstance(event.get("msg"), str):
        return False
    if any(event.get(field) is not None and not isinstance(event[field], str) for field in _OPTIONAL_STRING_FIELDS):
        return False
    if event.get("ctx") is not None and not isinstance(event["ctx"], dict):
        return False
    tags = event.get("tags")
    return tags is None or (isinstance(tags, list) and all(isinstance(tag, str) for tag in tags))
