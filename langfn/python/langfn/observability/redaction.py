from __future__ import annotations

from typing import Any, Iterable, Mapping


def redact(value: Any, *, keys: Iterable[str]) -> Any:
    keyset = set(keys)
    return _redact(value, keyset=keyset)


def _redact(value: Any, *, keyset: set[str]) -> Any:
    if isinstance(value, Mapping):
        out = {}
        for k, v in value.items():
            if str(k) in keyset:
                out[k] = "***REDACTED***"
            else:
                out[k] = _redact(v, keyset=keyset)
        return out
    if isinstance(value, list):
        return [_redact(v, keyset=keyset) for v in value]
    return value

