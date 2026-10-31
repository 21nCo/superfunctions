"""Runs the shared redaction vectors against a ``logfn`` module.

Used by tests/test_conformance.py and, from a clean virtual environment, by
scripts/clean_consumer.py, so it imports nothing from the repository.
"""

from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from types import ModuleType
from typing import Any

VECTORS_PATH = Path(__file__).parent / "conformance" / "redaction-vectors.json"
TYPESCRIPT_VECTORS_PATH = (
    Path(__file__).resolve().parents[2] / "typescript" / "conformance" / "redaction-vectors.json"
)


def load_vectors(path: Path = VECTORS_PATH) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _build_error(spec: dict[str, Any]) -> BaseException:
    error_type = type(spec["name"], (Exception,), {})
    try:
        raise error_type(spec["message"])
    except Exception as raised:
        error = raised
    if "cause" in spec:
        error.__cause__ = build_context_value(spec["cause"], [], None, None)
    return error


def build_context_value(value: Any, refs: list[tuple[Any, Any, str]], parent: Any, key: Any) -> Any:
    if isinstance(value, list):
        items: list[Any] = []
        for index, item in enumerate(value):
            items.append(build_context_value(item, refs, items, index))
        return items
    if not isinstance(value, dict):
        return value
    if isinstance(value.get("$ref"), str):
        refs.append((parent, key, value["$ref"]))
        return None
    if isinstance(value.get("$bytes"), dict):
        data = value["$bytes"]["text"].encode("utf-8")
        kind = value["$bytes"]["kind"]
        return data if kind == "bytes" else bytearray(data) if kind == "mutable" else memoryview(data)
    if isinstance(value.get("$dag"), dict):
        node = build_context_value(value["$dag"]["leaf"], refs, None, None)
        for _ in range(value["$dag"]["depth"]):
            node = {"a": node, "b": node}
        return node
    if isinstance(value.get("$error"), dict):
        return _build_error(value["$error"])
    built: dict[str, Any] = {}
    for child_key, item in value.items():
        built[child_key] = build_context_value(item, refs, built, child_key)
    return built


def build_context(ctx: dict[str, Any] | None) -> dict[str, Any] | None:
    """Builds a vector ctx: ``$error`` becomes an exception, ``$bytes`` binary data, ``$ref`` a
    shared or circular reference, ``$dag`` a shared graph."""
    if ctx is None:
        return None
    refs: list[tuple[Any, Any, str]] = []
    root = build_context_value(ctx, refs, None, None)
    for parent, key, path in refs:
        target: Any = root
        for segment in path.split(".") if path else []:
            target = target[segment]
        parent[key] = target
    return root


def vector_event(vector: dict[str, Any], with_layers: bool = True) -> dict[str, Any]:
    event: dict[str, Any] = {
        "ts": "2026-10-27T00:00:00.000Z",
        "level": "error",
        "msg": vector["input"]["msg"],
        "name": "vectors",
        "version": "0",
    }
    ctx = build_context(vector["input"].get("ctx"))
    layers = vector.get("layers") if with_layers else None
    if layers:
        ctx = {**layers.get("enrich", {}), **layers.get("base", {}), **layers.get("child", {}), **(ctx or {})}
    if ctx is not None:
        event["ctx"] = ctx
    for field in ("tags", "userId", "tenantId"):
        if field in vector["input"]:
            value = vector["input"][field]
            event[field] = list(value) if isinstance(value, list) else value
    event.update(copy.deepcopy(vector["input"].get("fields", {})))
    return event


def _match(actual: Any, expected: Any, where: str) -> None:
    if isinstance(expected, dict) and isinstance(expected.get("$match"), dict):
        assert isinstance(actual, str), f"{where}: expected a string, got {actual!r}"
        for text in expected["$match"].get("includes", []):
            assert text in actual, f"{where}: {text!r} missing from {actual!r}"
        for text in expected["$match"].get("excludes", []):
            assert text not in actual, f"{where}: {text!r} present in {actual!r}"
        return
    if isinstance(expected, list):
        assert isinstance(actual, list), f"{where}: expected a list, got {actual!r}"
        assert len(actual) == len(expected), f"{where}: length {len(actual)} != {len(expected)}"
        for index, item in enumerate(expected):
            _match(actual[index], item, f"{where}[{index}]")
        return
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{where}: expected an object, got {actual!r}"
        assert sorted(actual) == sorted(expected), f"{where}: keys {sorted(actual)} != {sorted(expected)}"
        for child_key, item in expected.items():
            _match(actual[child_key], item, f"{where}.{child_key}")
        return
    assert actual == expected and type(actual) is type(expected), f"{where}: {actual!r} != {expected!r}"


def expect_vector(actual: dict[str, Any], vector: dict[str, Any], mode: str) -> None:
    for field, expected in vector["expected"].items():
        _match(actual.get(field), expected, f"{vector['id']} ({mode}) {field}")
    serialized = json.dumps(actual, ensure_ascii=False, default=str)
    for text in vector.get("absent", []):
        assert text not in serialized, f"{vector['id']} ({mode}): {text!r} is in the event"


def _log_vector(logfn: ModuleType, vector: dict[str, Any], pipeline: list[Any], sink: Any) -> None:
    layers = vector.get("layers") or {}
    data = vector["input"]

    def identity_stage(event: dict[str, Any]) -> dict[str, Any]:
        # Sets fields the Logger API has no argument for, as a caller-added stage would.
        identity = {field: data[field] for field in ("userId", "tenantId") if field in data}
        return {**event, **identity, **copy.deepcopy(data.get("fields", {}))}

    stages: list[Any] = [identity_stage]
    if "enrich" in layers:
        stages.append(logfn.enrich_context(layers["enrich"]))
    root = logfn.create_logger(
        "vectors",
        level="trace",
        base_context=layers.get("base"),
        pipeline=[*stages, *pipeline],
        sinks=[sink],
    )
    logger = root.child(ctx=layers["child"]) if "child" in layers else root
    logger.error(data["msg"], vector_event(vector, with_layers=False).get("ctx"), data.get("tags"))


def run_vector(logfn: ModuleType, vector: dict[str, Any]) -> list[str]:
    """Checks one vector through the stage, the logger and the HTTP sink (fed by
    the logger and called directly); returns the modes run."""
    options = vector.get("options") or {}

    stage = logfn.redact(**options)
    once = stage(vector_event(vector))
    expect_vector(once, vector, "stage")
    expect_vector(stage(once), vector, "stage twice")
    expect_vector(logfn.redact_event(vector_event(vector), **options), vector, "redact_event")

    captured: list[dict[str, Any]] = []
    _log_vector(logfn, vector, [logfn.redact(**options)], captured.extend)
    assert len(captured) == 1, f"{vector['id']} (logger): {len(captured)} events"
    expect_vector(captured[0], vector, "logger")

    bodies: list[bytes] = []

    async def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
        bodies.append(body)
        return 200

    def http_sink() -> Any:
        return logfn.SinkHttp(
            "https://collector.test/ingest",
            transport=transport,
            redact_keys=options.get("keys"),
            redact_allowlist=options.get("allowlist"),
            **({"redact_replacement": options["replacement"]} if "replacement" in options else {}),
        )

    sink = http_sink()
    _log_vector(logfn, vector, [], sink)
    asyncio.run(sink.flush())
    direct = http_sink()
    direct([vector_event(vector)])
    asyncio.run(direct.flush())
    assert len(bodies) == 2, f"{vector['id']} (SinkHttp): {len(bodies)} requests"
    for body, mode in zip(bodies, ("SinkHttp", "SinkHttp direct"), strict=True):
        events = json.loads(body)["events"]
        assert len(events) == 1
        expect_vector(events[0], vector, mode)
    return ["stage", "logger", "SinkHttp", "SinkHttp direct"]
