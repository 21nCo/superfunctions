from __future__ import annotations

from typing import Any, Iterable, Mapping


DEFAULT_REDACTION_KEYS = {
    "apikey",
    "apikeyref",
    "apikeyid",
    "authorization",
    "accesstoken",
    "refreshtoken",
    "token",
    "email",
    "ssn",
}


def redact(value: Any, *, keys: Iterable[str]) -> Any:
    keyset = DEFAULT_REDACTION_KEYS | {_normalize_key(key) for key in keys}
    return _redact(value, keyset=keyset)


def _redact(value: Any, *, keyset: set[str]) -> Any:
    if isinstance(value, Mapping):
        out = {}
        for k, v in value.items():
            if _normalize_key(str(k)) in keyset:
                out[k] = "***REDACTED***"
            else:
                out[k] = _redact(v, keyset=keyset)
        return out
    if isinstance(value, list):
        return [_redact(v, keyset=keyset) for v in value]
    return value


def _normalize_key(value: str) -> str:
    return "".join(ch.lower() for ch in value if ch.isalnum())
