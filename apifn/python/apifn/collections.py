from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any

import httpx
import yaml

from ._redact import Registry, redact_text

_VAR_RE = re.compile(r"{{\s*([\w.-]+)\s*}}")
_MAX_ERROR_CHARS = 500


def _registry(url: str, headers: dict[str, str], body: str | None, variables: dict[str, str], client: Any) -> Registry:
    """Credential values a request could expose: its own, credential-named variables and the client's defaults."""
    registry = Registry()
    try:
        registry.collect_named(variables)
        registry.collect_request(url, headers.items(), body)
        registry.collect_request("", [(str(k), str(v)) for k, v in getattr(client, "headers", {}).items()], None)
        for cookie in getattr(getattr(client, "cookies", None), "jar", []):
            registry.collect_request("", [("cookie", f"{cookie.name}={cookie.value}")], None)
    except Exception:  # noqa: BLE001 - what could not be read adds nothing; the text rules still apply
        pass
    return registry


def _collect_sent(registry: Registry, exc: BaseException) -> None:
    """Adds the request an httpx exception carries, as the client sent it (auth flows, default headers)."""
    try:
        sent = getattr(exc, "request", None)
        if isinstance(sent, httpx.Request):
            content = sent.content.decode("utf-8", errors="replace") or None
            registry.collect_request(str(sent.url), [(str(k), str(v)) for k, v in sent.headers.items()], content)
    except Exception:  # noqa: BLE001 - httpx raises when no request is attached or the body was streamed
        pass


def _error_summary(exc: BaseException, registry: Registry) -> str:
    """The exception type and message, redacted before it is cut, so a cut never exposes part of a credential."""
    try:
        message = redact_text(str(exc), registry)
    except Exception as failure:  # noqa: BLE001 - a summary that cannot be sanitized is withheld
        message = f"[REDACTED: summary withheld because it could not be sanitized ({type(failure).__name__})]"
    summary = f"{type(exc).__name__}: {message}" if message else type(exc).__name__
    return summary[:_MAX_ERROR_CHARS]


def _safe_name(name: Any, registry: Registry) -> Any:
    try:
        return redact_text(name, registry) if isinstance(name, str) else name
    except Exception:  # noqa: BLE001 - a name that cannot be sanitized is withheld
        return "[REDACTED]"


def _interpolate(value: str, context: dict[str, str]) -> str:
    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        return str(context.get(key, match.group(0)))

    return _VAR_RE.sub(repl, value)


def _walk_requests(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in items:
        kind = item.get("kind")
        if kind == "request" and item.get("request"):
            out.append(item)
        elif kind == "folder":
            out.extend(_walk_requests(item.get("children") or []))
    return out


def read_collection(directory: str | Path) -> dict[str, Any]:
    root = Path(directory)
    top = root / "opencollection.yml"
    if not top.exists():
        raise FileNotFoundError(f"Missing opencollection.yml in {root}")

    with top.open("r", encoding="utf-8") as f:
        collection = yaml.safe_load(f) or {}

    collection.setdefault("info", {})
    collection.setdefault("items", [])
    collection.setdefault("environments", {})
    return collection


def run_collection(collection: dict[str, Any], options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    env_name = options.get("environment", "default")
    overrides = options.get("overrides") or {}
    timeout = float(options.get("timeout", 30.0))

    envs = collection.get("environments") or {}
    if env_name not in envs:
        raise ValueError(f"Environment '{env_name}' not found")

    env = (envs.get(env_name) or {}).copy()
    variables = (env.get("variables") or {}).copy()
    variables.update(overrides)
    context = {k: str(v) for k, v in variables.items()}

    requests = _walk_requests(collection.get("items") or [])
    started = time.time()

    own_client = False
    client = options.get("client")
    if client is None:
        own_client = True
        client = httpx.Client(timeout=timeout)

    results: list[dict[str, Any]] = []

    try:
        for item in requests:
            req = item["request"]["http"]
            method = req["method"].upper()
            url = _interpolate(req["url"], context)
            headers = {
                h["name"]: _interpolate(h.get("value", ""), context)
                for h in req.get("headers", [])
            }

            body = None
            if req.get("body") and req["body"].get("data") is not None:
                body = _interpolate(str(req["body"]["data"]), context)

            registry = _registry(url, headers, body, context, client)
            started_req = time.time()
            try:
                resp = client.request(method, url, headers=headers, content=body)
                duration_ms = int((time.time() - started_req) * 1000)
                status = "passed" if resp.status_code < 400 else "failed"
                results.append(
                    {
                        "name": _safe_name(item["name"], registry),
                        "status": status,
                        "duration": duration_ms,
                        "statusCode": resp.status_code,
                        "assertions": [],
                    }
                )
            except Exception as exc:
                duration_ms = int((time.time() - started_req) * 1000)
                _collect_sent(registry, exc)
                results.append(
                    {
                        "name": _safe_name(item["name"], registry),
                        "status": "error",
                        "duration": duration_ms,
                        "assertions": [],
                        "error": _error_summary(exc, registry),
                    }
                )
    finally:
        if own_client:
            client.close()

    duration = int((time.time() - started) * 1000)
    summary = {
        "total": len(results),
        "passed": sum(1 for r in results if r["status"] == "passed"),
        "failed": sum(1 for r in results if r["status"] == "failed"),
        "skipped": sum(1 for r in results if r["status"] == "skipped"),
        "errors": sum(1 for r in results if r["status"] == "error"),
        "duration": duration,
    }

    return {
        "collectionName": collection.get("info", {}).get("name", "collection"),
        "environment": env_name,
        "duration": duration,
        "results": results,
        "summary": summary,
    }
