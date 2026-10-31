"""Redaction shared with the TypeScript package.

The rules mirror ``logfn/typescript/src/pipeline/redact.ts`` and both are
checked against ``tests/conformance/redaction-vectors.json``. Change them
together.
"""

from __future__ import annotations

import re
import traceback
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from functools import lru_cache
from re import Pattern
from typing import Any, TypeVar, cast

from .types import LogEvent

REDACTED = "[redacted]"
CIRCULAR = "[circular]"
MAX_DEPTH = "[max-depth]"
# Replacement for values past one walk's MAX_TRAVERSAL budget
MAX_SIZE = "[max-size]"
# Replacement for values with no JSON form, binary data included: text rules
# cannot see secrets in bytes, so their content is never kept.
UNSERIALIZABLE = "[unserializable]"
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
# Userinfo runs to the last ``@`` of the authority, as URL parsers read it, so
# an unencoded ``@`` in a password (``postgres://u:p@ss@db``) is redacted too.
_URL_USERINFO = re.compile(r"(?<![A-Za-z0-9+.\-])([A-Za-z][A-Za-z0-9+.\-]*://)[^ \t\n\r\f\v/?#]+@", re.ASCII)
# A query or fragment parameter: ``?name=``, ``&name=`` or ``#name=``.
_QUERY_PARAM = re.compile(r"""[?&#]([^=&#? \t\n\r\f\v"'<>]+)=""", re.ASCII)
# The same parameter inside a percent-encoded URL (a redirect target):
# ``%3Fname%3D``, ``%26name%3D`` or ``%23name%3D``.
_ENCODED_QUERY_PARAM = re.compile(
    # Linear: ``%`` is not in the class, so each character matches one way.
    r"%(?:3F|26|23)((?:[A-Za-z0-9_.~\-]|%(?!3D|3F|26|23)[0-9A-Fa-f]{2})+)%3D", re.ASCII | re.IGNORECASE  # NOSONAR S5852
)
# A query value ends at the next parameter, whitespace, a double quote or an
# escaped quote (a URL inside escaped JSON); commas and semicolons are kept.
# A backslash run is consumed whole, so matching stays linear.
_QUERY_VALUE = re.compile(r"""(?:[^&# \t\n\r\f\v"<>\\]|\\+(?![\\"']))*""", re.ASCII)
# An encoded value also ends at an encoded ``&`` or ``#``.
_ENCODED_QUERY_VALUE = re.compile(
    r"""(?:[^&#% \t\n\r\f\v"<>\\]|%(?!2[36])|\\+(?![\\"']))*""", re.ASCII | re.IGNORECASE
)
# The name may be quoted, also with escaped quotes (``\"name\":`` in JSON that
# was itself serialized into a string), and may be percent-encoded. Any
# whitespace JSON allows may surround the separator; after it, also escaped
# whitespace (``\n``, ``\r\n``, ``\t`` in serialized pretty-printed JSON).
# Escapes are not accepted before the separator: in ``x\n\n\n...`` every
# ``n`` would start a name and rescan the run, which is quadratic. At most
# seven backslashes (three levels of escaping) keep matching linear.
_SPACE_BEFORE_SEPARATOR = r"[ \t\r\n]*"
_SPACE_AFTER_SEPARATOR = r"(?:[ \t\r\n]|\\{1,7}[nrt])*"
_KEY_SEPARATOR = re.compile(
    r"""(\\{0,7}["']?)(?<![A-Za-z0-9_.%\-])([A-Za-z0-9_.%\-]+)\1("""
    + _SPACE_BEFORE_SEPARATOR
    + "[:=]"
    + _SPACE_AFTER_SEPARATOR
    + ")",
    re.ASCII,
)
# A quoted name made of several words, such as ``"api key":`` or ``'api key' =``.
_SPACED_KEY_SEPARATOR = re.compile(
    r"""(\\{0,7}["'])([A-Za-z0-9_.%\-]+(?: [A-Za-z0-9_.%\-]+)+)\1("""
    + _SPACE_BEFORE_SEPARATOR
    + "[:=]"
    + _SPACE_AFTER_SEPARATOR
    + ")",
    re.ASCII,
)
_AUTH_SCHEME = re.compile(r"(?:bearer|basic|digest|negotiate)[ \t]+", re.ASCII | re.IGNORECASE)
# Characters that end an unquoted value
_UNQUOTED_STOP = frozenset(" \t\n\r\f\v&;,#\"'")
_LINE_REST = re.compile(r"[^\r\n]*", re.ASCII)
_BEARER_TOKEN = re.compile(r"(?<![A-Za-z0-9])(bearer)[ \t]+[A-Za-z0-9\-._~+/]+=*", re.ASCII | re.IGNORECASE)
_GLUED_BEARER = re.compile(r"bearer[ \t]+[A-Za-z0-9\-._~+/]+=*", re.ASCII | re.IGNORECASE)
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


_T = TypeVar("_T")


def _short_key_cache(function: Callable[[str], _T]) -> Callable[[str], _T]:
    # Keys up to 256 characters only: a cached key lives as long as the process.
    cached = lru_cache(maxsize=4096)(function)
    return lambda key: cached(key) if len(key) <= 256 else function(key)


# Keys repeat heavily (the same names in every event, every query string), so
# the per-key work is cached. Percent-escapes are decoded first, so
# ``api%5Fkey`` is ``api_key``; only ASCII escapes matter, everything else is
# removed by the normalization anyway.
@_short_key_cache
def _normalize_key(key: str) -> str:
    return _NON_ALNUM.sub("", _PERCENT_ESCAPE.sub(_decode_ascii_escape, key).lower())


@_short_key_cache
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
    # Whether the rules keep the replacement itself
    settled: bool = True

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
    # An empty marker would make ``password= next`` read as a password of ``next``.
    if not isinstance(replacement, str) or not replacement:
        raise ValueError("redaction replacement must be a non-empty string")
    extra = frozenset(k for k in (_normalize_key(key) for key in (keys or ())) if k)
    redactor = _Redactor(replacement, compiled, frozenset(allowlist or ()), extra)
    # A marker such as ``SECRET`` would read as a credential name, so ``SECRET: word`` loses the word on the next call.
    if redactor.is_sensitive(replacement):
        raise ValueError("redaction replacement must not be a sensitive key name")
    settled = _apply_rules((replacement, []), redactor)[0] == replacement
    return _Redactor(redactor.replacement, redactor.patterns, redactor.allowlist, redactor.extra_keys, settled)


def _quoted_value_end(text: str, start: int, slashes: int, quote: str) -> int:
    # End of a quoted value whose opening quote is preceded by ``slashes``
    # backslashes; ``start`` is just after the opening quote. Each level of
    # string escaping doubles the backslashes, so a quote closes the value
    # when the backslash run before it is congruent to ``slashes`` modulo
    # 2 * (slashes + 1). The value runs across lines to its closing quote, so
    # a multi-line credential (a PEM key) is consumed whole; an unterminated
    # value runs to the end of the input. Callers redact through the returned
    # end, so no text is scanned twice.
    index = start
    length = len(text)
    while index < length:
        char = text[index]
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


def _glued_end(text: str, start: int) -> int:
    # End of text glued to the end of a quoted or bracketed value, as in
    # ``"x"TAIL`` or ``[x]TAIL``. A backslash also ends it, so the escaped
    # whitespace after a value in serialized JSON (``\"x\"\n``) is kept. A
    # bearer token in it (``"x"Bearer abc``) is taken in whole, as after a separator.
    index = start
    length = len(text)
    while index < length:
        char = text[index]
        if char == "\\" or char in _UNQUOTED_STOP or char in "}]":
            break
        before = text[index - 1]
        if char in "bB" and not (before.isascii() and before.isalnum()):
            bearer = _GLUED_BEARER.match(text, index)
            if bearer:
                return bearer.end()
        index += 1
    return index


def _unquoted_value_end(text: str, start: int) -> int:
    # End of an unquoted value: whitespace, a separator, a quote or a closing
    # bracket it did not open (``{token=x}``) ends it. Brackets opened inside
    # it are part of it, so ``abc[1]TAIL`` is one value.
    depth = 0
    index = start
    length = len(text)
    while index < length:
        char = text[index]
        if char in _UNQUOTED_STOP:
            break
        if char in "{[":
            depth += 1
        elif char in "}]":
            if depth == 0:
                break
            depth -= 1
        index += 1
    return index


def _bracketed_value_end(text: str, start: int) -> int:
    # End of the bracketed value opening at ``start`` (``{`` or ``[``), across
    # lines; quoted strings, also escaped ones, are skipped so brackets inside
    # them do not count. An unbalanced value runs to the end of the input.
    depth = 0
    index = start
    length = len(text)
    while index < length:
        char = text[index]
        if char in "{[":
            depth += 1
            index += 1
        elif char in "}]":
            depth -= 1
            index += 1
            if depth == 0:
                return index
        elif char in "\\\"'":
            slashes = 0
            while index + slashes < length and text[index + slashes] == "\\":
                slashes += 1
            quote = text[index + slashes : index + slashes + 1]
            if quote in ('"', "'"):
                index = _quoted_value_end(text, index + slashes + 1, slashes, quote)
            else:
                index += slashes
        else:
            index += 1
    return index


def _scan_value(text: str, start: int, replacement: str) -> tuple[int, str, int] | None:
    # The credential value at ``start``: a value already replaced by
    # ``replacement`` together with anything appended to it, a bracketed
    # value, or an optional auth scheme followed by a complete quoted string
    # (escaped quotes included) or an unquoted token. Returns its end, the
    # quote, with its escaping backslashes, written around the replacement,
    # and where unquoted text glued to a closing quote or bracket starts;
    # None when nothing is left to redact.
    if replacement and text.startswith(replacement, start):
        end = _unquoted_value_end(text, start + len(replacement))
        return (end, "", start + len(replacement)) if end > start + len(replacement) else None
    if text[start : start + 1] in ("{", "["):
        # Text glued to the closing bracket, as in ``[x]TAIL``, is part of the value.
        tail = _bracketed_value_end(text, start)
        return _glued_end(text, tail), "", tail
    scheme = _AUTH_SCHEME.match(text, start)
    position = scheme.end() if scheme else start
    slashes = 0
    while position + slashes < len(text) and text[position + slashes] == "\\":
        slashes += 1
    quote = text[position + slashes : position + slashes + 1]
    if quote in ('"', "'"):
        # Text glued to the closing quote, as in ``"x"TAIL``, is part of the value.
        tail = _quoted_value_end(text, position + slashes + 1, slashes, quote)
        return _glued_end(text, tail), text[position : position + slashes + 1], tail
    for origin in (start,) if position == start else (position, start):
        end = _unquoted_value_end(text, origin)
        if end > origin:
            return end, "", origin
    return None


# Text being redacted, with the [start, end) spans of the markers written so
# far, flattened: [start0, end0, start1, end1, ...].
_Marked = tuple[str, list[int]]


@dataclass
class _Edit:
    # A span to replace by the marker, with text written just before and after it.
    start: int
    end: int
    before: str = ""
    after: str = ""
    # Where the rule reads on, if before ``end``
    resume: int | None = None


def _rewrite(
    marked: _Marked, trigger: Pattern[str], replacement: str, edit: Callable[[re.Match[str], int, int], _Edit | None]
) -> _Marked:
    # Runs one rule. Its trigger matches caller text only, one stretch between
    # markers at a time, so no rule reads a marker as part of a key, an email
    # or a pattern. ``edit`` maps a match (``at`` is the stretch offset,
    # ``covered`` the end of the last span) to the span to replace, or None; a
    # value may run on past markers and takes them in.
    text, marks = marked
    edits: list[_Edit] = []
    covered = 0
    resume = 0
    for mark in range(0, len(marks) + 1, 2):
        at = 0 if mark == 0 else marks[mark - 1]
        stretch = text[at : marks[mark] if mark < len(marks) else len(text)]
        position = max(0, resume - at)
        while position <= len(stretch):
            match = trigger.search(stretch, position)
            if match is None:
                break
            found = edit(match, at, covered)
            if found:
                # A marker that touches another one joins it, so redacting twice gives the same text; one
                # inside the last (a key glued to its value) extends it.
                prev = edits[-1] if edits else None
                if prev and at + match.start() < prev.end:
                    edits.pop()
                    found = _Edit(prev.start, max(prev.end, found.end), prev.before, prev.after, found.resume)
                elif not found.before and prev and prev.end == found.start and not prev.after:
                    edits.pop()
                    found.start, found.before = prev.start, prev.before
                elif not found.before and mark > 0 and found.start == at and (prev.end if prev else 0) <= marks[mark - 2]:
                    found.start = marks[mark - 2]
                following = mark
                while following < len(marks) and (
                    marks[following] < found.end or (not found.after and marks[following] == found.end)
                ):
                    found.end = max(found.end, marks[following + 1])
                    following += 2
                edits.append(found)
                covered = found.end
                resume = found.end if found.resume is None else found.resume
            # An empty match moves on by one character, as re.sub does.
            position = max(resume - at, match.end(), match.start() + 1)
    parts: list[str] = []
    spans: list[int] = []
    size = copied = index = 0

    def copy(until: int) -> None:
        # Markers inside a replaced span are dropped; the others keep their place.
        nonlocal size, index
        while index < len(marks) and marks[index] < until:
            if marks[index] >= copied:
                spans.extend((size + marks[index] - copied, size + marks[index + 1] - copied))
            index += 2
        parts.append(text[copied:until])
        size += until - copied

    for item in edits:
        copy(item.start)
        spans.extend((size + len(item.before), size + len(item.before) + len(replacement)))
        parts.append(item.before + replacement + item.after)
        size += len(item.before) + len(replacement) + len(item.after)
        copied = item.end
    copy(len(text))
    return "".join(parts), spans


def _redact_query_params(marked: _Marked, redactor: _Redactor, param: Pattern[str], value: Pattern[str]) -> _Marked:
    # Redacts sensitive query and fragment parameter values up to the next
    # parameter, so ``?password=one,two`` loses all of ``one,two``. A value
    # that is exactly the replacement is rewritten to itself, so this is
    # idempotent.
    def edit(match: re.Match[str], at: int, _covered: int) -> _Edit | None:
        value_start = at + match.end()
        if not redactor.is_sensitive(match.group(1)):
            return None
        value_end = cast(re.Match[str], value.match(marked[0], value_start)).end()
        return None if value_end == value_start else _Edit(value_start, value_end)

    return _rewrite(marked, param, redactor.replacement, edit)


def _redact_assignments(marked: _Marked, redactor: _Redactor, separator: Pattern[str]) -> _Marked:
    # A non-sensitive pair consumes only its name and separator so a
    # credential inside the value (for example a query after ``https:``) is
    # still found.
    replacement = redactor.replacement
    text = marked[0]

    def edit(match: re.Match[str], at: int, covered: int) -> _Edit | None:
        value_start = at + match.end()
        if not redactor.is_sensitive(match.group(2)):
            return None
        value = _scan_value(text, value_start, replacement)
        # An unquoted ``Authorization:`` or ``Cookie:`` header value is the whole line.
        header_line = (
            (value is None or value[1] == "")
            and ":" in match.group(3)
            and _normalize_key(match.group(2)) in _HEADER_LINE_KEYS
        )
        if header_line:
            line_end = cast(re.Match[str], _LINE_REST.match(text, value_start)).end()
            value_end = max(line_end, value[0] if value else value_start)
        else:
            value_end = value[0] if value else value_start
        if value_end == value_start:
            return None
        quote = "" if header_line or value is None else value[1]
        # Text glued to the value is read again, so a credential key in it
        # (``"v"xAuthorization: Basic x``) takes its value in too.
        resume = value[2] if not header_line and value and value[2] >= covered else value_end
        return _Edit(value_start, value_end, quote, quote, resume)

    return _rewrite(marked, separator, replacement, edit)


def _apply_rules(marked: _Marked, redactor: _Redactor) -> _Marked:
    replacement = redactor.replacement
    # The userinfo between the scheme and the last ``@`` only.
    result = _rewrite(
        marked,
        _URL_USERINFO,
        replacement,
        lambda m, at, _covered: _Edit(at + m.start() + len(m.group(1)), at + m.end() - 1),
    )
    result = _redact_query_params(result, redactor, _QUERY_PARAM, _QUERY_VALUE)
    result = _redact_query_params(result, redactor, _ENCODED_QUERY_PARAM, _ENCODED_QUERY_VALUE)
    result = _redact_assignments(result, redactor, _KEY_SEPARATOR)
    result = _redact_assignments(result, redactor, _SPACED_KEY_SEPARATOR)
    result = _rewrite(
        result,
        _BEARER_TOKEN,
        replacement,
        lambda m, at, _covered: _Edit(at + m.start() + len(m.group(1)), at + m.end(), " "),
    )
    for pattern in redactor.patterns:
        result = _rewrite(result, pattern, replacement, lambda m, at, _covered: _Edit(at + m.start(), at + m.end()))
    return result


def _redact_text(value: str, redactor: _Redactor) -> str:
    # Each pass keeps the markers of the last, so no rule reads one as caller
    # text. A settled result must also stay the same when its markers are read
    # as text, as a later stage or sink reads them, or the next pass starts
    # from that reading; text that does not settle in four passes becomes the
    # replacement. With a replacement the rules would redact itself, the
    # first result that keeps its markers is kept.
    marked: _Marked = (value, [])
    for _ in range(4):
        result = _apply_rules(marked, redactor)
        same = result[0] == marked[0]
        if same and (not marked[1] or not redactor.settled):
            fresh = result
        elif redactor.settled:
            fresh = _apply_rules((result[0], []), redactor)
        else:
            fresh = marked
        if fresh[0] == result[0]:
            return result[0]
        marked = fresh if same else result
    return redactor.replacement


def _child_path(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def format_exception_stack(error: BaseException, message: str | None = None) -> str:
    """``stack``: the last 64 frames (file, line, function; no source is read) and ``Type: message``."""
    # A name over 200 characters becomes [max-size] whole: a cut could end inside a secret redaction then misses.
    text = exception_message(error) if message is None else message
    def fit(name: str) -> str:
        return name if len(name) <= 200 else MAX_SIZE
    walk = deque(traceback.walk_tb(error.__traceback__), maxlen=64)
    frames = traceback.StackSummary.from_list([(fit(f.f_code.co_filename), n, fit(f.f_code.co_name), "") for f, n in walk]).format()
    head = ["Traceback (most recent call last):\n"] if frames else []
    return "".join([*head, *frames, f"{type(error).__name__}: {text}\n" if text else f"{type(error).__name__}\n"])


def exception_message(error: BaseException) -> str:
    try:
        return str(error)
    except Exception:  # pragma: no cover - a broken __str__
        return repr(error)


def unique_key(target: dict[str, Any], key: str, used: dict[str, int], reserved: frozenset[str] = frozenset()) -> str:
    # Distinct keys can become the same text: 1 and "1" when sanitized, two
    # email keys both redacted to the marker. Each later one is kept under the first free
    # "<key>#<n>" (n from 2) instead of overwriting the earlier value. ``used``
    # holds the next n per key; ``reserved`` names are never taken, wherever
    # they come in key order.
    if key not in target and key not in reserved:
        return key
    index = used.get(key, 2)
    while f"{key}#{index}" in target or f"{key}#{index}" in reserved:
        index += 1
    used[key] = index + 1
    return f"{key}#{index}"


def _redact_node(value: Any, redactor: _Redactor, path: str, ancestors: set[int], depth: int) -> Any:
    # ``value`` is a sanitized copy: JSON values only, an error already a record.
    if isinstance(value, str):
        return value if path in redactor.allowlist else _redact_text(value, redactor)
    if not isinstance(value, (dict, list)):
        return value
    identity = id(value)
    if identity in ancestors:
        return CIRCULAR
    if depth >= MAX_REDACTION_DEPTH:
        return MAX_DEPTH

    ancestors.add(identity)
    try:
        if isinstance(value, dict):
            result: dict[str, Any] = {}
            used: dict[str, int] = {}
            for key, item in value.items():
                item_path = _child_path(path, key)
                allowed = item_path in redactor.allowlist
                # Keys are text too: a map keyed by URL or email must not leak them.
                output_key = unique_key(result, key if allowed else _redact_text(key, redactor), used)
                # A value is replaced when the written key is sensitive too, so redacting the output again keeps it.
                if not allowed and (redactor.is_sensitive(key) or redactor.is_sensitive(output_key)):
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
    # the ctx root. It redacts the JSON-safe copy (one bounded walk), where an
    # error is a record whose fields obey the key rules.
    from .validation import SCHEMA_FIELDS, sanitize_event  # validation imports this module

    redacted: dict[str, Any] = {}
    used: dict[str, int] = {}
    sanitized: dict[str, Any] = dict(sanitize_event(event))
    for key, value in sanitized.items():
        allowed = key in redactor.allowlist
        if key == "msg":
            redacted[key] = value if allowed else _redact_text(value, redactor)
        elif key == "ctx":
            redacted[key] = _redact_node(value, redactor, "", set(), 0)
        else:
            # Field names are text too, exactly like nested keys; an allowlisted
            # name is kept, and any collision keeps both values. A schema field
            # keeps its name, and no other field takes a schema name.
            name = key if key in SCHEMA_FIELDS else unique_key(
                redacted, key if allowed else _redact_text(key, redactor), used, SCHEMA_FIELDS
            )
            sensitive = not allowed and (redactor.is_sensitive(key) or redactor.is_sensitive(name))
            redacted[name] = redactor.replacement if sensitive else _redact_node(value, redactor, key, set(), 0)
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
