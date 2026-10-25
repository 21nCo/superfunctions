"""JSON-safe values shared by logging and redaction."""
import json
import math
from datetime import date, datetime
from typing import Any, cast

from .types import LogEvent


def sanitize_value(value: Any) -> Any:
    ancestors: set[int] = set()

    def visit(item: Any, depth: int) -> Any:
        if item is None or isinstance(item, (str, bool)):
            return item
        if isinstance(item, int):
            # Python may reject decimal conversion under its configured digit
            # limit. Keep that protection enabled and isolate the bad value.
            try:
                str(item)
            except (ValueError, OverflowError):
                return "[unserializable]"
            return item
        if isinstance(item, float):
            return item if math.isfinite(item) else None
        identity = id(item)
        if identity in ancestors:
            return "[circular]"
        if depth >= 64:
            return "[depth_limit]"
        ancestors.add(identity)
        try:
            if isinstance(item, (datetime, date)):
                return item.isoformat()
            if isinstance(item, BaseException):
                return {"name": type(item).__name__, "message": str(item)}
            if isinstance(item, dict):
                return {key: visit(child, depth + 1) for key, child in item.items() if isinstance(key, str)}
            if isinstance(item, (list, tuple)):
                return [visit(child, depth + 1) for child in item]
            return "[unserializable]"
        except Exception:
            return "[unserializable]"
        finally:
            ancestors.remove(identity)

    return visit(value, 0)


MAX_EVENT_SIZE = 64 * 1024


def _size(value: Any) -> int:
    # Covers console JSON; conservative for compact UTF-8 HTTP JSON.
    return len(json.dumps(value, allow_nan=False).encode("utf-8"))


def bound_event(event: LogEvent) -> LogEvent:
    """Preserve whole context entries within the serialized event budget."""
    result = sanitize_value(event)
    if "tags" in result:
        result["tags"] = result["tags"][:20]
    if _size(result) <= MAX_EVENT_SIZE:
        return cast(LogEvent, result)
    context = result.get("ctx", {})
    result["ctx"] = {"_truncated": True, "_reason": "size_limit"}
    required = {"ts", "level", "msg", "name", "version", "ctx"}
    for key in list(result):
        if _size(result) <= MAX_EVENT_SIZE:
            break
        if key not in required:
            del result[key]
    for key in ("msg", "name", "version", "ts"):
        if _size(result) <= MAX_EVENT_SIZE:
            break
        value = result[key]
        low, high = 1, len(value)
        while low < high:
            middle = (low + high + 1) // 2
            result[key] = value[:middle]
            if _size(result) <= MAX_EVENT_SIZE:
                low = middle
            else:
                high = middle - 1
        result[key] = value[:low]
    remaining = MAX_EVENT_SIZE - _size(result)
    for key, value in context.items():
        if key in ("_truncated", "_reason"):
            continue
        cost = _size(key) + _size(value) + 4  # colon-space and comma-space
        if cost <= remaining:
            result["ctx"][key] = value
            remaining -= cost
    return cast(LogEvent, result)
