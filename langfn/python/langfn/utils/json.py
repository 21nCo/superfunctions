from __future__ import annotations

from typing import Optional


def extract_first_json_object(text: str) -> Optional[str]:
    """
    Extract the first balanced JSON object substring from arbitrary text.

    This is intentionally lightweight (no third-party deps) and safe for typical LLM outputs
    like: "prefix { ... } suffix".
    """
    s = text.strip()
    if not s:
        return None
    if s.startswith("{") and s.endswith("}"):
        return s

    start = s.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return s[start : i + 1]

    return None
