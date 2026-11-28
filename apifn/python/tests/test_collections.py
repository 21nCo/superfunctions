from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any, Callable

import httpx
import yaml

from apifn import read_collection, run_collection
from apifn._redact import Registry, redact_text, redact_url


def test_tv_py_004_collection_read_and_run(tmp_path: Path) -> None:
    collection_dir = tmp_path / "collection"
    collection_dir.mkdir()

    (collection_dir / "opencollection.yml").write_text(
        yaml.safe_dump(
            {
                "info": {"name": "Sample"},
                "environments": {
                    "default": {
                        "variables": {
                            "baseUrl": "https://api.test",
                        }
                    }
                },
                "items": [
                    {
                        "kind": "request",
                        "name": "Ping",
                        "request": {
                            "http": {
                                "method": "GET",
                                "url": "{{baseUrl}}/ping",
                                "headers": [],
                            }
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    collection = read_collection(collection_dir)

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.test/ping"
        return httpx.Response(200, json={"ok": True})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        report = run_collection(collection, {"environment": "default", "client": client})
    finally:
        client.close()

    assert report["summary"]["total"] == 1
    assert report["summary"]["passed"] == 1
    assert report["results"][0]["status"] == "passed"


def test_run_collection_raises_for_missing_environment() -> None:
    collection = {
        "info": {"name": "Sample"},
        "environments": {"default": {"variables": {"baseUrl": "https://api.test"}}},
        "items": [],
    }

    try:
        run_collection(collection, {"environment": "staging"})
    except ValueError as exc:
        assert str(exc) == "Environment 'staging' not found"
    else:
        raise AssertionError("expected missing environment to raise")


def _fake(label: str) -> str:
    # Fake credentials are assembled at runtime so no committed literal looks like a secret.
    return "-".join(["test", label, "value"])


def _run(http: dict[str, Any], variables: dict[str, str], handler: Callable[[httpx.Request], httpx.Response], name: str = "Call", **client: Any) -> dict[str, Any]:
    collection = {
        "info": {"name": "Sample"},
        "environments": {"default": {"variables": {"baseUrl": "https://api.test", **variables}}},
        "items": [{"kind": "request", "name": name, "request": {"http": http}}],
    }
    http_client = httpx.Client(transport=httpx.MockTransport(handler), **client)
    try:
        return run_collection(collection, {"environment": "default", "client": http_client})["results"][0]
    finally:
        http_client.close()


def test_exception_summary_redacts_url_header_body_and_echoed_credentials() -> None:
    fakes = {name: _fake(name) for name in ("query-api-key", "access-token", "session-header", "client-secret", "redirect-code")}
    http = {
        "method": "POST",
        "url": "{{baseUrl}}/oauth/token?api_key={{queryKey}}&page=2",
        "headers": [
            {"name": "Authorization", "value": "Bearer {{accessToken}}"},
            {"name": "X-Session", "value": "{{sessionHeader}}"},
        ],
        "body": {"data": "grant_type=client_credentials&client_secret={{clientSecret}}"},
    }
    variables = {"queryKey": fakes["query-api-key"], "accessToken": fakes["access-token"], "sessionHeader": fakes["session-header"], "clientSecret": fakes["client-secret"]}

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            f"connect failed for {request.url}\nheaders={dict(request.headers)}\nbody={request.content.decode()}\n"
            f"redirect=https://app.test/cb?code={fakes['redirect-code']}&status=completed\nechoed {fakes['session-header']} twice",
            request=request,
        )

    result = _run(http, variables, handler)
    error = result["error"]
    assert result["status"] == "error"
    assert error.startswith("ConnectError: connect failed for https://api.test/oauth/token?api_key=[REDACTED]")
    # The keyword rule redacts from a credential key to the end of its line.
    assert "redirect=https://app.test/cb?code=[REDACTED]\n" in error
    assert "echoed [REDACTED] twice" in error
    assert not [value for value in fakes.values() if value in error]
    assert len(error) <= 500


def test_exception_summary_scrubs_client_defaults_auth_flow_and_credential_variables() -> None:
    default_key, cookie, auth_password, variable = _fake("default-key"), _fake("jar-session1"), _fake("auth-password"), _fake("variable-token")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadError(f"peer echoed {default_key} {cookie} {request.headers.get('authorization')} {variable} region us", request=request)

    result = _run(
        {"method": "GET", "url": "{{baseUrl}}/x"},
        {"refreshToken": variable, "region": "us"},
        handler,
        headers={"X-Upstream-Key": default_key},
        cookies={"sid": cookie, "region": "us"},
        auth=("client", auth_password),
    )
    error = result["error"]
    for value in (default_key, cookie, auth_password, variable, base64.b64encode(f"client:{auth_password}".encode()).decode()):
        assert value not in error
    assert error.endswith("region us")


def test_exception_summary_is_cut_only_after_redaction_and_withheld_when_unsanitizable(monkeypatch: Any) -> None:
    secret = _fake("long-client-secret")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("x" * 480 + f" client_secret={secret}", request=request)

    error = _run({"method": "GET", "url": "{{baseUrl}}/x"}, {}, handler)["error"]
    assert len(error) == 500 and "test-long" not in error

    import apifn.collections as module

    def broken(*_args: Any, **_kwargs: Any) -> str:
        raise RuntimeError("redaction failed")

    monkeypatch.setattr(module, "redact_text", broken)
    error = _run({"method": "GET", "url": "{{baseUrl}}/x"}, {}, handler)["error"]
    assert error == "ConnectError: [REDACTED: summary withheld because it could not be sanitized (RuntimeError)]"


def test_registry_collects_only_credential_values_never_literals_counts_or_plain_cookies() -> None:
    registry = Registry()
    registry.collect_request(
        "https://h.test/cb?status=completed&code=abcd1234",
        [("cookie", "region=us; sid=s1x2c3v4"), ("content-type", "application/json")],
        json.dumps({"otp": 135791, "enabled": True, "note": None, "max_tokens": 4096, "headers": [{"name": "X-Api-Key", "value": "kv-0001"}]}),
    )
    assert set(registry.values) >= {"abcd1234", "s1x2c3v4", "135791", "kv-0001"}
    assert not {"completed", "us", "True", "true", "None", "4096"} & set(registry.values)
    assert registry.scrub("max 4096, otp 135791, code abcd1234x") == "max 4096, otp [REDACTED], code [REDACTED]x"


_VECTORS = json.loads((Path(__file__).resolve().parents[2] / "collections" / "__tests__" / "fixtures" / "redaction-vectors.json").read_text(encoding="utf-8"))
_VALUE = _fake("vector")


def _fill(template: str) -> str:
    text = template.replace(_VECTORS["placeholder"], _VALUE)
    for placeholder, value in _VECTORS["fill"].items():
        text = text.replace(placeholder, value)
    return text


def test_shared_vectors_are_redacted_and_redacting_twice_changes_nothing() -> None:
    for shape in _VECTORS["shapes"]:
        once = redact_text(_fill(shape))
        assert _VALUE not in once, shape
        assert redact_text(once) == once, shape
    for case in _VECTORS["configured"]:
        once = redact_text(_fill(case["text"]), None, case["redactHeaders"])
        assert _VALUE not in once and redact_text(once, None, case["redactHeaders"]) == once, case["text"]


def test_shared_combinations_never_keep_a_credential_value() -> None:
    combinations = _VECTORS["combinations"]
    failures = []
    for prefix in combinations["prefixes"]:
        for form in combinations["forms"]:
            for suffix in combinations["suffixes"]:
                text = prefix + _fill(form) + suffix
                once = redact_text(text)
                if _VALUE in once or redact_text(once) != once:
                    failures.append(text)
    assert failures == []


def test_shared_userinfo_references_are_redacted_and_paths_without_authority_are_kept() -> None:
    # userinfoRefs lists what a WHATWG URL parser reads with userinfo; the vitest suite recomputes the list.
    urls = _VECTORS["urls"]
    for scheme, separator, info, host in urls["userinfoRefs"]:
        reference = _fill(urls["schemes"][scheme] + urls["separators"][separator] + urls["userinfo"][info] + "{AT}" + urls["hosts"][host])
        assert _VALUE not in redact_url(reference), repr(reference)
        assert _VALUE not in redact_text(f"redirected to {reference} once"), repr(reference)
    for template in urls["kept"]:
        assert redact_text(f"Location: {_fill(template)}") == f"Location: {_fill(template)}", template


def _elapsed(work: Callable[[], object]) -> float:
    best = float("inf")
    for _ in range(3):
        started = time.perf_counter()
        work()
        best = min(best, time.perf_counter() - started)
    return max(best, 0.005)


def test_every_text_pass_stays_linear() -> None:
    # 4x the input may cost about 4x the time (8x allowed for noise), never 16x.
    shapes = ["token=a ", 'name="X-Api-Key"\n', '{"name":"X-Api-Key","a":', 'password: {"a": [', "\\u0022access_token\\u0022:", "https://a b", "//u:p@h ", "x:y?z "]
    for shape in shapes:
        small = _elapsed(lambda: redact_text(shape * (10_000 // len(shape))))
        large = _elapsed(lambda: redact_text(shape * (40_000 // len(shape))))
        assert large / small < 8, shape
    registry = Registry()
    for index in range(2000):
        registry.add(f"credentialvalue{index}")
    small = _elapsed(lambda: registry.scrub("credentialvalu" * 2_000))
    large = _elapsed(lambda: registry.scrub("credentialvalu" * 8_000))
    assert large / small < 8
    assert registry.scrub("see credentialvalue42 here") == "see [REDACTED] here"
