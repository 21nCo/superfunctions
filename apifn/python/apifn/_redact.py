"""Credential redaction for collection run exception summaries (API-41).

This mirrors the Layer 2 text redaction of ``@apifn/core`` (redact.ts): known
credential values are scrubbed first, then a line-oriented keyword rule that
fails closed, then URL tokens lose their userinfo and credential parameters.
Every pass is linear; nothing recurses on untrusted input.
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any, Iterable
from urllib.parse import quote, unquote, unquote_plus

REDACTED = "[REDACTED]"
_MIN_VALUE = 4
_SCAN_BACK = 16_384

_DEFAULT_HEADERS = {
    "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "x-access-token",
    "x-refresh-token", "x-csrf-token", "x-xsrf-token", "x-amz-security-token", "x-goog-api-key", "dpop",
}
_EXACT = {"bearer", "code", "devicecode", "handoffcode", "otp", "session", "sid", "usercode"}
_SUFFIXES = (
    "accesskey", "apikey", "assertion", "authorization", "backupcode", "codeverifier", "cookie", "credential",
    "credentials", "jwt", "passphrase", "passwd", "password", "privatekey", "recoverycode", "secret", "secretkey",
    "sessionid", "sessionkey", "signature", "signingkey", "token",
)
_HEADER_WORDS = ("authorization", "cert", "cookie", "credential", "hmac", "jwt", "passwd", "password", "secret", "session", "signature", "token")
_HEADER_PARTS = {"auth", "csrf", "otp", "sig", "xsrf"}
_URL_EXTRA = {"state", "key", "nonce", "sig", "auth"}
_TEXT_WORDS = (
    "token", "secret", "passw", "passphrase", "apikey", "authoriz", "credential", "cookie", "session", "signature",
    "privatekey", "accesskey", "jwt", "assertion", "csrf", "xsrf", "bearer",
)
_TEXT_EXACT = {"code", "codes", "sid", "state", "auth", "pwd"}
_BARE = {"token", "tokens", "secret", "secrets", "key", "keys", "code", "codes", "state", "auth", "bearer"}
_NAME_KEYS = {"name", "key", "header", "field", "param", "parameter"}
_VALUE_KEYS = {"value", "values", "val", "content"}
_SPECIAL = {"http", "https", "ws", "wss", "ftp", "file"}
_KEY_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.+!#$%*^`|~")
_WORD = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")
_ESCAPE_RE = re.compile(r"(?:%[0-9a-fA-F]{2})+|\\+u([0-9a-fA-F]{4})")
_TOKEN_SHAPED = re.compile(r"[A-Za-z0-9\-._~+/]{8,}=*")
_PEM_RE = re.compile(r"-----BEGIN ([A-Z0-9 ]{0,40}PRIVATE KEY)-----")
_SCHEME_AUTH_RE = re.compile(r"\b(?:Bearer|Basic)[ \t]+([A-Za-z0-9\-._~+/]+=*)")
_ESCAPED_QUOTE_END = re.compile(r"\\+u00(?:22|27)$", re.I)
_ESCAPED_QUOTE_START = re.compile(r"\\+u00(?:22|27)", re.I)
_OPEN, _CLOSE = "([{<", ")]}>"


def _decode(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        if match.group(1) is not None:
            return chr(int(match.group(1), 16))
        try:
            return bytes.fromhex(match.group(0).replace("%", "")).decode("utf-8")
        except UnicodeDecodeError:
            return bytes.fromhex(match.group(0).replace("%", "")).decode("latin-1")

    return _ESCAPE_RE.sub(repl, text)


def _norm(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _candidates(key: str) -> list[str]:
    decoded = _decode(key).replace("\\", "")
    segment = re.search(r"\[([^\[\]]*)\]\s*$", decoded)
    return [decoded, segment.group(1)] if segment else [decoded]


def is_sensitive_key(key: str) -> bool:
    for candidate in _candidates(key):
        n = _norm(candidate)
        for form in (n, n[:-1] if n.endswith("s") else n):
            if form in _EXACT or form.endswith(_SUFFIXES):
                return True
    return False


def _header_words(name: str) -> bool:
    n, lower = _norm(name), name.strip().lower()
    return (
        lower in _DEFAULT_HEADERS
        or any(word in n for word in _HEADER_WORDS)
        or (n.endswith("key") and "-" in lower)
        or any(part in _HEADER_PARTS for part in re.split(r"[-_\s]+", lower))
    )


def is_credential_name(name: str, names: frozenset[str] = frozenset()) -> bool:
    return name.strip().lower() in names or is_sensitive_key(name) or any("-" in c and _header_words(c) for c in _candidates(name))


def _is_count(key: str, value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and _norm(_decode(key)).endswith("tokens")


def _is_text_keyword(token: str, names: frozenset[str]) -> bool:
    trimmed = re.sub(r"^[!#$*+^`|~.]+|[!#$*+^`|~.]+$", "", token)
    for form in (token, trimmed):
        if not form:
            continue
        if is_credential_name(form, names):
            return True
        for candidate in _candidates(form):
            n = _norm(candidate)
            if any(w in n for w in _TEXT_WORDS) or n in _TEXT_EXACT or n.endswith(("key", "otp", "otps")):
                return True
    return False


def _token_shaped(value: str) -> bool:
    return bool(_TOKEN_SHAPED.fullmatch(value)) and (bool(re.search(r"[^A-Za-z]", value)) or (value != value.lower() and value != value.upper()))


class Registry:
    """Credential values a run knows, scrubbed wherever they appear (Aho-Corasick, whole words for short values)."""

    def __init__(self, redact_headers: Iterable[str] = ()) -> None:
        self.names = frozenset(name.strip().lower() for name in redact_headers)
        self.values: dict[str, bool] = {}
        self._automaton: tuple[list[dict[str, int]], list[int], list[int], list[int], list[int]] | None = None

    def add(self, value: Any) -> None:
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            return
        text = str(value)
        if len(text) < _MIN_VALUE or len(text) > 65_536 or "[REDACTED" in text:
            return
        for form in {text, json.dumps(text)[1:-1], quote(text, safe="")}:
            if form not in self.values:
                self.values[form] = len(form) < 8 or form.isdigit() or not isinstance(value, str)
                self._automaton = None

    def collect_named(self, values: dict[str, Any] | None) -> None:
        for key, value in (values or {}).items():
            if is_credential_name(str(key), self.names) and not _is_count(str(key), value):
                self.add(value)

    def collect_request(self, url: str, headers: Iterable[tuple[str, str]], body: str | None) -> None:
        self.collect_url(url)
        content_type = None
        for name, value in headers:
            lower = name.lower()
            if lower == "content-type":
                content_type = value
            if lower in ("cookie", "set-cookie"):
                for part in re.split(r"[;,]" if lower == "set-cookie" else ";", value):
                    key, eq, cookie = part.partition("=")
                    if eq and (is_credential_name(key.strip(), self.names) or (len(cookie.strip()) >= 8 and re.search(r"\d", cookie))):
                        self.add(cookie.strip())
            elif is_credential_name(name, self.names) or _header_words(name) or (_norm(name).endswith("key") and len(_norm(name)) > 3):
                self.add(value)
                scheme = re.fullmatch(r"\s*(?:Bearer|Basic|Token|Digest|DPoP)\s+(\S+)\s*", value, re.I)
                if scheme:
                    self.add(scheme.group(1))
                    if value.strip().lower().startswith("basic"):
                        try:
                            decoded = base64.b64decode(scheme.group(1), validate=True).decode("utf-8")
                            self.add(decoded.partition(":")[2])
                        except ValueError:
                            pass
        if body:
            self.collect_body(body, content_type)

    def collect_url(self, url: str) -> None:
        info = _authority(url)
        if info and "@" in url[info[0] : info[1]]:
            userinfo = url[info[0] : url.rindex("@", info[0], info[1])]
            for part in userinfo.partition(":")[::2]:
                self.add(unquote(part))
        for part in re.split(r"[?#]", url, maxsplit=2)[1:]:
            for key, value in _params(part):
                if _is_url_key(key, self.names):
                    self.add(value)

    def collect_body(self, body: str, content_type: str | None) -> None:
        try:
            parsed = json.loads(body)
        except (ValueError, RecursionError):
            if _is_form(body, content_type):
                for key, value in _params(body):
                    if is_credential_name(key, self.names):
                        self.add(value)
            return
        pending: list[tuple[Any, bool]] = [(parsed, False)]
        while pending:
            value, credential = pending.pop()
            if isinstance(value, (list, dict)):
                if isinstance(value, list):
                    pair = len(value) == 2 and isinstance(value[0], str) and is_credential_name(value[0], self.names)
                    members = [(item, pair and index == 1) for index, item in enumerate(value)]
                else:
                    container = any(k.lower() in _NAME_KEYS and isinstance(v, str) and is_credential_name(v, self.names) for k, v in value.items())
                    members = [
                        (item, (is_credential_name(key, self.names) or (container and key.lower() in _VALUE_KEYS)) and not _is_count(key, item))
                        for key, item in value.items()
                    ]
                for item, member in members:
                    if member and not isinstance(item, (list, dict)):
                        self.add(item)
                    else:
                        pending.append((item, credential or member))
            elif credential and (not isinstance(value, str) or len(value) >= 8 or _token_shaped(value)):
                self.add(value)
        for match in re.finditer(r'"((?:[^"\\]|\\.){1,256})"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)', body):
            try:
                key = json.loads(f'"{match.group(1)}"')
                if is_credential_name(key, self.names) and not _norm(key).endswith("tokens"):
                    self.add(json.loads(match.group(2)))
            except ValueError:
                pass

    def _build(self) -> tuple[list[dict[str, int]], list[int], list[int], list[int], list[int]]:
        edges: list[dict[str, int]] = [{}]
        long, bounded = [0], [0]
        for value, whole_word in self.values.items():
            node = 0
            for char in value:
                nxt = edges[node].get(char)
                if nxt is None:
                    nxt = len(edges)
                    edges[node][char] = nxt
                    edges.append({})
                    long.append(0)
                    bounded.append(0)
                node = nxt
            if whole_word:
                bounded[node] = len(value)
            else:
                long[node] = len(value)
        fail, link = [0] * len(edges), [0] * len(edges)
        queue = list(edges[0].values())
        for node in queue:
            for char, child in edges[node].items():
                f = fail[node]
                while f and char not in edges[f]:
                    f = fail[f]
                target = edges[f].get(char, 0) if node else 0
                fail[child] = target if target != child else 0
                long[child] = max(long[child], long[fail[child]])
                link[child] = fail[child] if bounded[fail[child]] else link[fail[child]]
                queue.append(child)
        return edges, fail, long, bounded, link

    def scrub(self, text: str) -> str:
        if not self.values or len(text) < _MIN_VALUE:
            return text
        if self._automaton is None:
            self._automaton = self._build()
        edges, fail, long, bounded, link = self._automaton
        intervals: list[list[int]] = []
        state, n = 0, len(text)
        for i, char in enumerate(text):
            while state and char not in edges[state]:
                state = fail[state]
            state = edges[state].get(char, 0)
            start = i - long[state] + 1 if long[state] else i + 1
            node = state if bounded[state] else link[state]
            while node:
                begin = i - bounded[node] + 1
                if begin < start and (begin == 0 or text[begin - 1] not in _WORD) and (i + 1 == n or text[i + 1] not in _WORD):
                    start = begin
                node = link[node]
            if start > i:
                continue
            while intervals and intervals[-1][1] >= start - 1:
                start = min(start, intervals.pop()[0])
            intervals.append([start, i])
        if not intervals:
            return text
        out, last = [], 0
        for start, end in intervals:
            out.append(text[last:start] + REDACTED)
            last = end + 1
        return "".join(out) + text[last:]


def _params(raw: str) -> list[tuple[str, str]]:
    pairs = []
    for part in re.split(r"[&;]", raw):
        key, eq, value = part.partition("=")
        if eq and key:
            pairs.append((unquote_plus(key), unquote_plus(value)))
    return pairs


def _is_url_key(key: str, names: frozenset[str]) -> bool:
    return is_credential_name(key, names) or any(_norm(c) in _URL_EXTRA for c in _candidates(key))


def _is_form(body: str, content_type: str | None) -> bool:
    if content_type is not None:
        return "x-www-form-urlencoded" in content_type.lower()
    return re.fullmatch(r"[^\s=&]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*", body) is not None


# --- Layer 2 keyword rule -------------------------------------------------------------------------------------------


def _escape_len(text: str, i: int) -> int:
    j = i
    while j < len(text) and text[j] == "\\":
        j += 1
    return j - i + 5 if j > i and re.match(r"u[0-9a-fA-F]{4}", text[j : j + 5]) else 0


def _escaped(text: str, i: int, length: int) -> str:
    return chr(int(text[i + length - 4 : i + length], 16))


def _token_end(text: str, i: int) -> int:
    j, n = i, len(text)
    while j < n:
        c = text[j]
        if c == "%" and text[j : j + 3].lower() in ("%3d", "%3a", "%26", "%20", "%22", "%27"):
            break
        if c in _KEY_CHARS:
            j += 1
            continue
        esc = _escape_len(text, j) if c == "\\" else 0
        if esc and _escaped(text, j, esc) in _KEY_CHARS:
            j += esc
            continue
        if c == "[" and j > i:
            close = text.find("]", j, j + 64)
            if close > j and re.fullmatch(r"\[[^\s\[\]\"']*\]", text[j : close + 1]):
                j = close + 1
                continue
        break
    return j


def _separator_end(text: str, start: int, end: int) -> int:
    n = len(text)
    if end < n and (text[end] == "\t" or (text[start] == "-" and text[end] == " " and end + 1 < n and text[end + 1] not in " \t\r\n-")):
        return end + 1
    j, lines = end, 0
    while j < n and j < end + 64:
        c = text[j]
        esc = _escape_len(text, j) if c == "\\" else 0
        if c in "\"' \t":
            j += 1
        elif c in "\r\n" and lines < 2:
            lines += 1
            j += 1
        elif c == "\\" and not esc:
            j += 2 if text[j + 1 : j + 2] in ("n", "t", "r") else 1
        elif esc and _escaped(text, j, esc) in "\"' \t\n\r":
            j += esc
        elif text[j : j + 3].lower() in ("%22", "%27", "%20"):
            j += 3
        else:
            break
    if text[j : j + 1] == ":" and text[j : j + 3] != "://":
        return j + 1
    if text[j : j + 1] == "=":
        while text[j : j + 1] == "=":
            j += 1
        return j + 1 if text[j : j + 1] == ">" else j
    if text[j : j + 3].lower() in ("%3d", "%3a"):
        return j + 3
    k = start - 2
    while k >= 0 and k > start - 64 and (text[k] in _WORD or text[k] in ".-"):
        k -= 1
    if (start > 0 and text[start - 1] == "<") or (start > 0 and text[start - 1] == ":" and k >= 0 and text[k] == "<"):
        close = re.search(r"/?>", text[end : end + 256])
        if close and close.group(0) == ">":
            return end + close.start() + 1
    return -1


def _line_start(text: str, i: int) -> int:
    return max(text.rfind("\n", 0, i), text.rfind("\r", 0, i)) + 1


def _line_end(text: str, i: int) -> int:
    ends = [p for p in (text.find("\n", i), text.find("\r", i)) if p >= 0]
    return min(ends) if ends else len(text)


def _quote_mask(text: str) -> bytearray:
    mask, quote, i, n = bytearray(len(text)), "", 0, len(text)
    while i < n:
        c = text[i]
        if quote:
            mask[i] = 1
            if c in "\r\n":
                quote, mask[i] = "", 0
            elif c == "\\" and i + 1 < n and text[i + 1] not in "\r\n":
                i += 1
                mask[i] = 1
            elif c == quote:
                quote = ""
        elif c == '"' or (c == "'" and not (i > 0 and text[i - 1] in _WORD and i + 1 < n and text[i + 1] in _WORD)):
            quote, mask[i] = c, 1
        i += 1
    return mask


def _is_opener(text: str, i: int) -> bool:
    return text[i] in "([{" or (text[i] == "<" and i + 1 < len(text) and (text[i + 1].isalpha() or text[i + 1] in "/!?["))


class _Scan:
    def __init__(self, text: str, names: frozenset[str]) -> None:
        self.text, self.names, self.budget = text, names, 8 * len(text) + 100_000
        self._mask: bytearray | None = None

    @property
    def mask(self) -> bytearray:
        if self._mask is None:
            self._mask = _quote_mask(self.text)
        return self._mask

    def opener_before(self, start: int, mask: bytearray | None) -> int:
        stack, text = [], self.text
        for i in range(start - 1, max(-1, start - _SCAN_BACK - 1), -1):
            self.budget -= 1
            if self.budget < 0:
                return -1
            if mask is not None and mask[i]:
                continue
            c = text[i]
            if c in _CLOSE:
                stack.append(c)
            elif _is_opener(text, i):
                if not stack:
                    return i
                if _CLOSE[_OPEN.index(c)] != stack.pop():
                    return -1
        return -1

    def closer_after(self, opener: int, mask: bytearray | None) -> int:
        text, stack = self.text, [self.text[opener]]
        for i in range(opener + 1, len(text)):
            self.budget -= 1
            if self.budget < 0:
                return len(text)
            if mask is not None and mask[i]:
                continue
            c = text[i]
            if _is_opener(text, i):
                stack.append(c)
            elif c in _CLOSE:
                expected = _CLOSE[_OPEN.index(stack[-1])]
                if c == ">" and expected != ">":
                    continue
                if c != expected:
                    return len(text)
                stack.pop()
                if not stack:
                    return i
        return len(text)

    def balanced_end(self, start: int, end: int) -> int:
        text, mask, stacks = self.text, self.mask, ([], [])
        while True:
            for i in range(start, end):
                c = text[i]
                if c not in "()[]{}":
                    continue
                for index, stack in enumerate(stacks):
                    if index == 0 and mask[i]:
                        continue
                    if c in "([{":
                        stack.append(c)
                    elif stack and "([{"[")]}".index(c)] != stack.pop():
                        return len(text)
            if not (stacks[0] or stacks[1]) or end >= len(text):
                return end
            start, end = end, _line_end(text, end + 1)

    def part_end(self, line_start: int, line_end: int) -> int:
        text, boundary, end, scanned = self.text, None, line_start - 1, 0
        while end > 0 and scanned < _SCAN_BACK and boundary is None:
            while end > 0 and text[end - 1] in "\r\n":
                end -= 1
            start = _line_start(text, end)
            if re.fullmatch(r"--\S+", text[start:end]):
                boundary = text[start:end]
            scanned += end - start + 1
            end = start
        blank = re.search(r"\r?\n\r?\n", text[line_end:])
        if boundary is None or blank is None:
            return len(text)
        pos = line_end + blank.start()
        while True:
            start = text.find(boundary, pos)
            if start < 0:
                return len(text)
            end = _line_end(text, start)
            if text[start - 1] in "\r\n" and text[start + len(boundary) : end] in ("", "--"):
                return start - 2 if text[start - 2] == "\r" else start - 1
            pos = start + 1

    def spans(self) -> list[tuple[int, int]]:
        text, names, n = self.text, self.names, len(self.text)
        spans: list[tuple[int, int]] = []
        covered = key_covered = 0
        name_value_at = -1
        memo: dict[str, bool] = {}

        def container(name_start: int, name_end: int) -> None:
            nonlocal covered
            if name_start < covered:
                return
            line_start = _line_start(text, name_start)
            found = [self.opener_before(name_start, self.mask), self.opener_before(name_start, None)]
            opener = min(o if o >= 0 else line_start for o in found)
            if opener >= 0 and opener in found:
                start = opener + 1
                end = max(self.closer_after(opener, self.mask), self.closer_after(opener, None))
            else:
                start, line_end = line_start, _line_end(text, name_end)
                rest_empty = re.fullmatch(r"[\s\"';,]*", text[name_end:line_end]) is not None
                end = self.part_end(line_start, line_end) if rest_empty else self.balanced_end(line_start, line_end)
            if self.budget < 0:
                end = n
            spans.extend(((start, name_start), (name_end, end)))
            covered = max(covered, end)

        i = 0
        while i < n:
            c = text[i]
            esc = _escape_len(text, i) if c == "\\" else 0
            if c == "\\" and not esc and text[i + 1 : i + 2] in ("n", "t", "r"):
                i += 2
                continue
            if c not in _KEY_CHARS and not (esc and _escaped(text, i, esc) in _KEY_CHARS):
                i += 1
                continue
            start, end = i, _token_end(text, i)
            i = max(end, start + 1)
            if end - start > 256:
                continue
            token = text[start:end]
            keyword = memo.get(token)
            if keyword is None:
                keyword = _is_text_keyword(token, names)
                if len(memo) < 10_000:
                    memo[token] = keyword
            name_key = _norm(_decode(token)) in _NAME_KEYS
            separator = _separator_end(text, start, end) if keyword or name_key else -1
            if keyword and separator >= 0:
                if start < key_covered:
                    continue
                value_start = separator
                while value_start < n and text[value_start] in " \t":
                    value_start += 1
                value_end = _line_end(text, value_start)
                if re.fullmatch(r"[\s\"'{\[(<\\]*", text[value_start:value_end]):
                    nxt = value_end
                    while nxt < n and text[nxt].isspace():
                        nxt += 1
                    if nxt < n:
                        value_end = _line_end(text, nxt)
                value_end = self.balanced_end(value_start, value_end)
                if value_end > value_start:
                    spans.append((value_start, value_end))
                key_covered = value_end
                continue
            if name_key and separator >= 0:
                name_value_at = separator
                continue
            if not keyword or _norm(_decode(token)) in _BARE:
                continue
            ahead = end
            while ahead < n and text[ahead] == "\\":
                ahead += 1
            quote = text[start - 1] if start > 0 else ""
            before = _ESCAPED_QUOTE_END.search(text[max(0, start - 12) : start])
            after = _ESCAPED_QUOTE_START.match(text, end)
            if quote in ('"', "'") and ahead < n and text[ahead] == quote:
                name_start = start - 1
                while name_start > 0 and text[name_start - 1] == "\\":
                    name_start -= 1
                container(name_start, ahead + 1)
            elif before and after:
                container(start - len(before.group(0)), after.end())
            elif (quote == ">" and end < n and text[end] == "<") or (
                0 <= name_value_at and start - name_value_at <= 8 and re.fullmatch(r"[\s\"'\\]*", text[name_value_at:start])
            ):
                container(start, end)

        for match in _PEM_RE.finditer(text):
            close = text.find(f"-----END {match.group(1)}-----", match.end())
            spans.append((match.end(), n if close < 0 else close))
        for match in _SCHEME_AUTH_RE.finditer(text):
            if _token_shaped(match.group(1)):
                spans.append((match.start(1), match.end(1)))
        return spans


def _apply(text: str, spans: list[tuple[int, int]]) -> str:
    merged: list[list[int]] = []
    for start, end in sorted(span for span in spans if span[1] > span[0]):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    out, last = [], 0
    for start, end in merged:
        out.append(text[last:start] + REDACTED)
        last = end
    return "".join(out) + text[last:]


# --- Layer 2 URL tokens ---------------------------------------------------------------------------------------------


def _authority(token: str) -> tuple[int, int] | None:
    """The [start, end) of a URL token's authority (userinfo and host), or None when it has none."""
    match = re.match(r"([A-Za-z][A-Za-z0-9+.-]*):", token)
    special = match is None or match.group(1).lower() in _SPECIAL
    i = match.end() if match else 0
    if special:
        run = re.match(r"[\\/\t\r\n]*", token[i:])
        if match is None and len(re.sub(r"[\t\r\n]", "", run.group(0))) < 2:
            return None
        i += run.end()
    else:
        run = re.match(r"[\t\r\n]*/[\t\r\n]*/", token[i:])
        if run is None:
            return None
        i += run.end()
    end, stops = i, "/?#\\" if special else "/?#"
    while end < len(token) and token[end] not in stops:
        end += 1
    return i, end


def _redact_params(raw: str, names: frozenset[str]) -> str:
    parts = re.split(r"([&;])", raw)
    for index, part in enumerate(parts):
        key, eq, value = part.partition("=")
        if eq and key and value and value != REDACTED and _is_url_key(unquote_plus(key), names):
            parts[index] = f"{key}={REDACTED}"
    return "".join(parts)


def redact_url(token: str, names: frozenset[str] = frozenset()) -> str:
    """Removes userinfo and credential query and fragment parameters from a URL token (text, not parsed)."""
    info = _authority(token)
    head_end = info[1] if info else 0
    hash_at = token.find("#", head_end)
    query_at = token.find("?", head_end, hash_at if hash_at >= 0 else len(token))
    body, fragment = (token[:hash_at], token[hash_at + 1 :]) if hash_at >= 0 else (token, None)
    if query_at >= 0:
        body = body[: query_at + 1] + _redact_params(body[query_at + 1 :], names)
    out = body + ("" if fragment is None else "#" + _redact_params(fragment, names))
    if info and "@" in token[info[0] : info[1]]:
        out = out[: info[0]] + out[token.rindex("@", info[0], info[1]) + 1 :]
    return re.sub(r"[\t\r\n]", "", out) if out != token else out


def _trim_url_token(token: str) -> str:
    """Drops trailing punctuation; a closing bracket stays when the token opened one (such as a marker)."""
    end = len(token)
    while end and token[end - 1] in "\"'<>)]},.;":
        close = token[end - 1]
        opener = {"]": "[", ")": "(", "}": "{"}.get(close)
        if opener and token[: end - 1].count(opener) > token[: end - 1].count(close):
            break
        end -= 1
    return token[:end]


def _redact_urls(text: str, names: frozenset[str]) -> str:
    if not re.search(r"[@?#]", text):
        return text
    out, last, i, n = [], 0, 0, len(text)
    term_at = last_at = -1
    while i < n:
        c = text[i]
        if c.isascii() and c.isalpha() and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] in "+.-")):
            j = i + 1
            while j < n and (text[j].isascii() and text[j].isalnum() or text[j] in "+.-"):
                j += 1
            if j >= n or text[j] != ":":
                i = j
                continue
            prefix_end, scheme_less = j + 1, False
        elif c in "/\\" and re.match(r"[\\/][\t\r\n]*[\\/]", text[i : i + 8]):
            prefix_end, scheme_less = i + 1, True
        else:
            i += 1
            continue
        authority = prefix_end
        k = prefix_end
        while k < n and text[k] in "\\/\t\r\n":
            if text[k] in "\\/\t" or ((text[k - 1] in "\\/" or scheme_less) and re.match(r"[\t\r\n]*[\\/]", text[k : k + 8])):
                authority = k + 1
                k += 1
            else:
                break
        end = authority
        while end < n and text[end] not in " \r\n":
            end += 1
        if term_at < authority:
            last_at, term_at = -1, authority
            while term_at < n and text[term_at] not in "/?#\r\n":
                if text[term_at] == "@":
                    last_at = term_at
                term_at += 1
        if last_at >= authority and last_at >= end:
            end = last_at
            while end < n and text[end] not in " \r\n":
                end += 1
        slashes = scheme_less or bool(re.search(r"[\\/]", text[prefix_end:authority]))
        if slashes and term_at < n and text[term_at] in "\r\n" and last_at < authority and re.match(r"[\r\n\t ]*@", text[term_at : term_at + 64]):
            out.append(text[last:i] + text[i:authority] + REDACTED)
            last = i = term_at
            continue
        token = _trim_url_token(text[i:end])
        if re.search(r"[@?#]", token):
            replacement = redact_url(token, names)
            if replacement != token:
                out.append(text[last:i] + replacement)
                last = i + len(token)
        i = max(end, i + 1)
    return "".join(out) + text[last:] if out else text


def redact_text(text: str, registry: Registry | None = None, redact_headers: Iterable[str] = ()) -> str:
    """Layer 2 redaction: known values, then the keyword rule, then URL tokens."""
    if not text:
        return text
    names = frozenset(name.strip().lower() for name in redact_headers) | (registry.names if registry else frozenset())
    scrubbed = registry.scrub(text) if registry else text
    return _redact_urls(_apply(scrubbed, _Scan(scrubbed, names).spans()), names)
