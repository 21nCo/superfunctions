from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Any, Mapping, Optional, Sequence


def _normalize(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_normalize(entry) for entry in value]
    if isinstance(value, Mapping):
        normalized: dict[str, Any] = {}
        for key in sorted(value):
            item = value[key]
            if callable(item):
                continue
            normalized[str(key)] = _normalize(item)
        return normalized
    return str(value)


def stable_serialize_cache_payload(value: Any) -> str:
    return json.dumps(_normalize(value), sort_keys=True, separators=(",", ":"))


def _build_cache_key(kind: str, payload: Mapping[str, Any]) -> str:
    envelope = {"version": 1, "kind": kind, **payload}
    return hashlib.sha256(stable_serialize_cache_payload(envelope).encode("utf-8")).hexdigest()


def create_completion_cache_key(
    *,
    provider: str,
    model: str,
    prompt: str,
    metadata: Optional[Mapping[str, Any]] = None,
    namespace: Optional[str] = None,
) -> str:
    return _build_cache_key(
        "completion",
        {
            "provider": provider,
            "model": model,
            "prompt": prompt,
            "metadata": dict(metadata or {}),
            "namespace": namespace,
        },
    )


def create_chat_cache_key(
    *,
    provider: str,
    model: str,
    messages: Sequence[Any],
    metadata: Optional[Mapping[str, Any]] = None,
    namespace: Optional[str] = None,
) -> str:
    return _build_cache_key(
        "chat",
        {
            "provider": provider,
            "model": model,
            "messages": list(messages),
            "metadata": dict(metadata or {}),
            "namespace": namespace,
        },
    )


def create_embedding_cache_key(
    *,
    provider: str,
    model: str,
    inputs: Sequence[str],
    metadata: Optional[Mapping[str, Any]] = None,
    namespace: Optional[str] = None,
) -> str:
    return _build_cache_key(
        "embedding",
        {
            "provider": provider,
            "model": model,
            "inputs": list(inputs),
            "metadata": dict(metadata or {}),
            "namespace": namespace,
        },
    )


def create_retriever_cache_key(
    *,
    query: str,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    namespace: Optional[str] = None,
    filter: Optional[Mapping[str, Any]] = None,
    options: Optional[Mapping[str, Any]] = None,
) -> str:
    return _build_cache_key(
        "retriever",
        {
            "provider": provider,
            "model": model,
            "query": query,
            "namespace": namespace,
            "filter": dict(filter or {}),
            "options": dict(options or {}),
        },
    )
