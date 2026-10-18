"""JSON-safe values shared by logging and redaction."""
import math
from datetime import date, datetime
from typing import Any, Set


def sanitize_value(value: Any) -> Any:
    ancestors: Set[int] = set()

    def visit(item: Any, depth: int) -> Any:
        if item is None or isinstance(item, (str, bool, int)):
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
