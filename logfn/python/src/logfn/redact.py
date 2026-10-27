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
from functools import lru_cache
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
# A query or fragment parameter: ``?name=``, ``&name=`` or ``#name=``.
_QUERY_PARAM = re.compile(r"""[?&#]([^=&#? \t\n\r\f\v"'<>]+)=""", re.ASCII)
# A query value ends at the next parameter, whitespace, a double quote or an
# escaped quote (a URL inside escaped JSON); commas and semicolons are kept.
# A backslash run is consumed whole, so matching stays linear.
_QUERY_VALUE = re.compile(r"""(?:[^&# \t\n\r\f\v"<>\\]|\\+(?![\\"']))*""", re.ASCII)
# The name may be quoted, also with escaped quotes (``\"name\":`` in JSON that
# was itself serialized into a string), and may be percent-encoded. At most
# seven backslashes (three levels of escaping) keep matching linear.
_KEY_SEPARATOR = re.compile(
    r"""(\\{0,7}["']?)(?<![A-Za-z0-9_.%\-])([A-Za-z0-9_.%\-]+)\1([ \t]*[:=][ \t]*)""", re.ASCII
)
_AUTH_SCHEME = re.compile(r"(?:bearer|basic|digest|negotiate)[ \t]+", re.ASCII | re.IGNORECASE)
_UNQUOTED_VALUE = re.compile(r"""[^ \t\n\r\f\v&;,#"'}\]]+""", re.ASCII)
_LINE_REST = re.compile(r"[^\r\n]*", re.ASCII)
_BEARER_TOKEN = re.compile(r"(?<![A-Za-z0-9])(bearer)[ \t]+[A-Za-z0-9\-._~+/]+=*", re.ASCII | re.IGNORECASE)
EMAIL_PATTERN = re.compile(
    r"(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])", re.ASCII
)

# Default extra patterns applied after the credential rules
DEFAULT_PATTERNS: tuple[Pattern[str], ...] = (EMAIL_PATTERN,)

_NON_ALNUM = re.compile(r"[^a-z0-9]", re.ASCII)
_PERCENT_ESCAPE = re.compile(r"%([0-9A-Fa-f]{2})", re.ASCII)


def _decode_ascii_escape(match: re.Match[str]) -> str:
    code = int(match.group(1), 16)
    return chr(code) if code < 0x80 else ""


# Keys repeat heavily (the same names in every event, every query string), so
# the per-key work is cached. Percent-escapes are decoded first, so
# ``api%5Fkey`` is ``api_key``; only ASCII escapes matter, everything else is
# removed by the normalization anyway.
@lru_cache(maxsize=4096)
def _normalize_key(key: str) -> str:
    return _NON_ALNUM.sub("", _PERCENT_ESCAPE.sub(_decode_ascii_escape, key).lower())


@lru_cache(maxsize=4096)
def _builtin_sensitive(normalized: str) -> bool:
    if not normalized:
        return False
    if normalized in _SENSITIVE_EXACT:
        return True
    if any(part in normalized for part in _SENSITIVE_PARTS):
        return True
    return normalized.endswith(_SENSITIVE_SUFFIXES)


def is_sensitive_key(key: str, extra_keys: Iterable[str] = ()) -> bool:
    """Whether a key name denotes a credential, using the built-in rules plus
    any extra names (normalized the same way)."""
    normalized = _normalize_key(key)
    if _builtin_sensitive(normalized):
        return True
    return bool(normalized) and any(_normalize_key(extra) == normalized for extra in extra_keys)


@dataclass(frozen=True)
class _Redactor:
    replacement: str
    patterns: tuple[Pattern[str], ...]
    allowlist: frozenset[str]
    extra_keys: frozenset[str]

    def is_sensitive(self, key: str) -> bool:
        normalized = _normalize_key(key)
        return _builtin_sensitive(normalized) or normalized in self.extra_keys


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


def _quoted_value_end(text: str, start: int, slashes: int, quote: str) -> int:
    # End of a quoted value whose opening quote is preceded by ``slashes``
    # backslashes; ``start`` is just after the opening quote. Each level of
    # string escaping doubles the backslashes, so a quote closes the value
    # when the backslash run before it is congruent to ``slashes`` modulo
    # 2 * (slashes + 1). An unterminated value runs to the end of the line.
    index = start
    length = len(text)
    while index < length:
        char = text[index]
        if char in "\r\n":
            return index
        if char == "\\" or char == quote:
            run = 0
            while index + run < length and text[index + run] == "\\":
                run += 1
            if index + run < length and text[index + run] == quote:
                if run % (2 * (slashes + 1)) == slashes:
                    return index + run + 1
                index += run + 1
            else:
                index += run
            continue
        index += 1
    return index


def _scan_value(text: str, start: int) -> tuple[int, str] | None:
    # The credential value at ``start``: an optional auth scheme, then a
    # complete quoted string (escaped quotes included) or an unquoted token.
    # Returns its end and the quote, with its escaping backslashes, written
    # around the replacement.
    scheme = _AUTH_SCHEME.match(text, start)
    position = scheme.end() if scheme else start
    slashes = 0
    while position + slashes < len(text) and text[position + slashes] == "\\":
        slashes += 1
    quote = text[position + slashes : position + slashes + 1]
    if quote in ('"', "'"):
        end = _quoted_value_end(text, position + slashes + 1, slashes, quote)
        return end, text[position : position + slashes + 1]
    for origin in (start,) if position == start else (position, start):
        unquoted = _UNQUOTED_VALUE.match(text, origin)
        if unquoted:
            return unquoted.end(), ""
    return None


def _redact_query_params(text: str, redactor: _Redactor) -> str:
    # Redacts sensitive query and fragment parameter values up to the next
    # parameter, so ``?password=one,two`` loses all of ``one,two``.
    replacement = redactor.replacement
    parts: list[str] = []
    copied = 0
    position = 0
    while True:
        match = _QUERY_PARAM.search(text, position)
        if match is None:
            break
        value_start = match.end()
        position = value_start
        if not redactor.is_sensitive(match.group(1)) or text.startswith(replacement, value_start):
            continue
        value_end = cast(re.Match[str], _QUERY_VALUE.match(text, value_start)).end()
        if value_end == value_start:
            continue
        parts.append(text[copied:value_start] + replacement)
        copied = value_end
        position = value_end
    if copied == 0:
        return text
    parts.append(text[copied:])
    return "".join(parts)


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
        value = _scan_value(text, value_start)
        # An unquoted ``Authorization:`` or ``Cookie:`` header value is the whole line.
        header_line = (
            (value is None or value[1] == "")
            and ":" in match.group(3)
            and _normalize_key(match.group(2)) in _HEADER_LINE_KEYS
        )
        if header_line:
            value_end = cast(re.Match[str], _LINE_REST.match(text, value_start)).end()
        else:
            value_end = value[0] if value else value_start
        if value_end == value_start:
            continue
        quote = "" if header_line or value is None else value[1]
        parts.append(text[copied:value_start] + quote + replacement + quote)
        copied = value_end
        position = copied
    if copied == 0:
        return text
    parts.append(text[copied:])
    return "".join(parts)


def _redact_text(value: str, redactor: _Redactor) -> str:
    replacement = redactor.replacement
    result = _URL_USERINFO.sub(lambda m: f"{m.group(1)}{replacement}@", value)
    result = _redact_query_params(result, redactor)
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
                allowed = item_path in redactor.allowlist
                # Keys are text too: a map keyed by URL or email must not leak them.
                output_key = key if allowed else _redact_text(key, redactor)
                if redactor.is_sensitive(key) and not allowed:
                    result[output_key] = redactor.replacement
                else:
                    result[output_key] = _redact_node(item, redactor, item_path, ancestors, depth + 1)
            return result
        return [
            _redact_node(item, redactor, f"{path}[{index}]", ancestors, depth + 1)
            for index, item in enumerate(value)
        ]
    finally:
        ancestors.discard(identity)


def _redact_with(event: LogEvent, redactor: _Redactor) -> LogEvent:
    # Every top-level field is redacted, including fields outside the LogEvent
    # schema that a caller-added stage may have set. Paths for fields other
    # than ctx are their names (``userId``, ``tags[0]``); ctx paths start at
    # the ctx root.
    redacted: dict[str, Any] = {}
    for raw_key, value in event.items():
        key = str(raw_key)
        if key == "msg":
            redacted[key] = _redact_text(str(value), redactor)
        elif key == "ctx":
            redacted[key] = _redact_node(value, redactor, "", set(), 0)
        elif redactor.is_sensitive(key) and key not in redactor.allowlist:
            redacted[key] = redactor.replacement
        else:
            redacted[key] = _redact_node(value, redactor, key, set(), 0)
    return cast(LogEvent, redacted)


def redact_event(
    event: LogEvent,
    patterns: Iterable[str | Pattern[str]] | None = None,
    replacement: str = REDACTED,
    keys: Iterable[str] | None = None,
    allowlist: Iterable[str] | None = None,
) -> LogEvent:
    """Redact one event: message, ctx (recursively, including exceptions and
    cycles) and every other field, keys included. Returns a new event; the
    input is not modified."""
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
