"""Redaction shared with the TypeScript package.

The rules mirror ``logfn/typescript/src/pipeline/redact.ts`` and both are
checked against ``tests/conformance/redaction-vectors.json``. Change them
together.
"""

from __future__ import annotations

import re
import traceback
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date
from re import Pattern
from typing import Any, cast

from .types import LogEvent

REDACTED = "[redacted]"
CIRCULAR = "[circular]"
MAX_DEPTH = "[max-depth]"
MAX_REDACTION_DEPTH = 32

# Keys are compared lowercased with every non-alphanumeric character removed.
_SENSITIVE_EXACT = frozenset({"auth", "pwd", "pass", "session", "sid", "sig", "csrf", "xsrf", "otp"})
_SENSITIVE_PARTS = (
    "password",
    "passwd",
    "passphrase",
    "secret",
    "apikey",
    "accesskey",
    "privatekey",
    "authorization",
    "cookie",
    "credential",
    "sessionid",
    "bearer",
)
# Suffix-only so counters such as maxTokens or tokenCount are kept.
_SENSITIVE_SUFFIXES = ("token", "jwt", "signature")
# For these header names a ``name: value`` match redacts the rest of the line.
_HEADER_LINE_KEYS = frozenset({"authorization", "proxyauthorization", "cookie", "setcookie"})

# ASCII flag keeps character classes and case folding identical to JavaScript.
_URL_USERINFO = re.compile(r"(?<![A-Za-z0-9+.\-])([A-Za-z][A-Za-z0-9+.\-]*://)[^ \t\n\r\f\v/?#@]+@", re.ASCII)
_KEY_SEPARATOR = re.compile(r"""(["']?)(?<![A-Za-z0-9_.\-])([A-Za-z0-9_.\-]+)\1([ \t]*[:=][ \t]*)""", re.ASCII)
_ASSIGNED_VALUE = re.compile(
    r"""(?:(?:bearer|basic|digest|negotiate)[ \t]+)?(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^ \t\n\r\f\v&;,#"'}\]]+)""",
    re.ASCII | re.IGNORECASE,
)
_LINE_VALUE = re.compile(r"[^\r\n]+", re.ASCII)
_BEARER_TOKEN = re.compile(r"(?<![A-Za-z0-9])(bearer)[ \t]+[A-Za-z0-9\-._~+/]+=*", re.ASCII | re.IGNORECASE)
EMAIL_PATTERN = re.compile(
    r"(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])", re.ASCII
)

# Default extra patterns applied after the credential rules
DEFAULT_PATTERNS: tuple[Pattern[str], ...] = (EMAIL_PATTERN,)

_NON_ALNUM = re.compile(r"[^a-z0-9]", re.ASCII)


def _normalize_key(key: str) -> str:
    return _NON_ALNUM.sub("", key.lower())


def is_sensitive_key(key: str, extra_keys: Iterable[str] = ()) -> bool:
    """Whether a key name denotes a credential, using the built-in rules plus
    any extra names (normalized the same way)."""
    normalized = _normalize_key(key)
    if not normalized:
        return False
    if normalized in _SENSITIVE_EXACT:
        return True
    if any(part in normalized for part in _SENSITIVE_PARTS):
        return True
    if normalized.endswith(_SENSITIVE_SUFFIXES):
        return True
    return any(_normalize_key(extra) == normalized for extra in extra_keys)


@dataclass(frozen=True)
class _Redactor:
    replacement: str
    patterns: tuple[Pattern[str], ...]
    allowlist: frozenset[str]
    extra_keys: frozenset[str]

    def is_sensitive(self, key: str) -> bool:
        return is_sensitive_key(key) or _normalize_key(key) in self.extra_keys


def _compile(
    patterns: Iterable[str | Pattern[str]] | None = None,
    replacement: str = REDACTED,
    keys: Iterable[str] | None = None,
    allowlist: Iterable[str] | None = None,
) -> _Redactor:
    compiled = (
        DEFAULT_PATTERNS
        if patterns is None
        else tuple(re.compile(p) if isinstance(p, str) else p for p in patterns)
    )
    extra = frozenset(k for k in (_normalize_key(key) for key in (keys or ())) if k)
    return _Redactor(replacement, compiled, frozenset(allowlist or ()), extra)


def _redact_assignments(text: str, redactor: _Redactor) -> str:
    # A non-sensitive pair consumes only its name and separator so a
    # credential inside the value (for example a query after ``https:``) is
    # still found.
    replacement = redactor.replacement
    parts: list[str] = []
    copied = 0
    position = 0
    while True:
        match = _KEY_SEPARATOR.search(text, position)
        if match is None:
            break
        value_start = match.end()
        position = value_start
        if not redactor.is_sensitive(match.group(2)) or text.startswith(replacement, value_start):
            continue
        following = text[value_start : value_start + 1]
        to_line_end = (
            ":" in match.group(3)
            and _normalize_key(match.group(2)) in _HEADER_LINE_KEYS
            and following not in ('"', "'")
        )
        value = (_LINE_VALUE if to_line_end else _ASSIGNED_VALUE).match(text, value_start)
        if value is None:
            continue
        raw = value.group(0)
        quote = raw[0] if raw[0] in ('"', "'") else ""
        parts.append(text[copied:value_start] + quote + replacement + quote)
        copied = value.end()
        position = copied
    if copied == 0:
        return text
    parts.append(text[copied:])
    return "".join(parts)


def _redact_text(value: str, redactor: _Redactor) -> str:
    replacement = redactor.replacement
    result = _URL_USERINFO.sub(lambda m: f"{m.group(1)}{replacement}@", value)
    result = _redact_assignments(result, redactor)
    result = _BEARER_TOKEN.sub(lambda m: f"{m.group(1)} {replacement}", result)
    for pattern in redactor.patterns:
        result = pattern.sub(replacement, result)
    return result


def _child_path(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def format_exception_stack(error: BaseException) -> str:
    """The traceback text used as an error's ``stack``."""
    return "".join(traceback.format_exception(type(error), error, error.__traceback__))


def exception_message(error: BaseException) -> str:
    try:
        return str(error)
    except Exception:  # pragma: no cover - a broken __str__
        return repr(error)


def _redact_node(value: Any, redactor: _Redactor, path: str, ancestors: set[int], depth: int) -> Any:
    if isinstance(value, str):
        return value if path in redactor.allowlist else _redact_text(value, redactor)
    if value is None or isinstance(value, (bool, int, float, date)):
        return value
    if not isinstance(value, (dict, list, tuple, set, frozenset, BaseException)):
        # Left for sanitization, which renders unknown objects as "[unserializable]".
        return value
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
                "message": _redact_node(
                    exception_message(value), redactor, _child_path(path, "message"), ancestors, depth + 1
                ),
                "stack": _redact_node(
                    format_exception_stack(value), redactor, _child_path(path, "stack"), ancestors, depth + 1
                ),
            }
            if value.__cause__ is not None:
                error["cause"] = _redact_node(
                    value.__cause__, redactor, _child_path(path, "cause"), ancestors, depth + 1
                )
            return error
        if isinstance(value, dict):
            result: dict[str, Any] = {}
            for raw_key, item in value.items():
                key = str(raw_key)
                item_path = _child_path(path, key)
                if redactor.is_sensitive(key) and item_path not in redactor.allowlist:
                    result[key] = redactor.replacement
                else:
                    result[key] = _redact_node(item, redactor, item_path, ancestors, depth + 1)
            return result
        return [
            _redact_node(item, redactor, f"{path}[{index}]", ancestors, depth + 1)
            for index, item in enumerate(value)
        ]
    finally:
        ancestors.discard(identity)


def _redact_with(event: LogEvent, redactor: _Redactor) -> LogEvent:
    redacted = cast(LogEvent, dict(event))
    redacted["msg"] = _redact_text(str(event["msg"]), redactor)
    if "ctx" in event:
        redacted["ctx"] = _redact_node(event["ctx"], redactor, "", set(), 0)
    if isinstance(event.get("tags"), list):
        redacted["tags"] = [
            _redact_text(tag, redactor) if isinstance(tag, str) else tag for tag in event["tags"]
        ]
    for field in ("userId", "tenantId"):
        value = event.get(field)
        if isinstance(value, str) and field not in redactor.allowlist:
            redacted[field] = _redact_text(value, redactor)
    return redacted


def redact_event(
    event: LogEvent,
    patterns: Iterable[str | Pattern[str]] | None = None,
    replacement: str = REDACTED,
    keys: Iterable[str] | None = None,
    allowlist: Iterable[str] | None = None,
) -> LogEvent:
    """Redact one event: message, ctx (recursively, including exceptions and
    cycles), tags, userId and tenantId. Returns a new event; the input is not
    modified."""
    return _redact_with(event, _compile(patterns, replacement, keys, allowlist))


def make_redactor(
    patterns: Iterable[str | Pattern[str]] | None = None,
    replacement: str = REDACTED,
    keys: Iterable[str] | None = None,
    allowlist: Iterable[str] | None = None,
) -> Callable[[LogEvent], LogEvent]:
    """Compile options once and return ``event -> redacted event``."""
    redactor = _compile(patterns, replacement, keys, allowlist)

    def redact_stage(event: LogEvent) -> LogEvent:
        return _redact_with(event, redactor)

    return redact_stage
