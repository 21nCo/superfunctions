from __future__ import annotations

import os
import sys

from flask import Flask


TESTS_DIR = os.path.dirname(__file__)
FLASK_ROOT = os.path.abspath(os.path.join(TESTS_DIR, ".."))
PYTHON_CORE_ROOT = os.path.abspath(
    os.path.join(TESTS_DIR, "..", "..", "python-core")
)

for path in (FLASK_ROOT, PYTHON_CORE_ROOT):
    if path not in sys.path:
        sys.path.insert(0, path)

from superfunctions.http import Response, Route, SetCookie  # noqa: E402
from superfunctions.http.openapi import generate_openapi_document  # noqa: E402
from superfunctions.http.types import HttpMethod  # noqa: E402
from superfunctions_flask.adapter import SUPERFUNCTIONS_ROUTE_ATTR, create_blueprint  # noqa: E402


def test_flask_adapter_preserves_repeated_cookies_and_route_metadata() -> None:
    async def create_session(request, context):
        return Response(
            status=200,
            cookies=[
                SetCookie(
                    name="__Secure-authfn.session",
                    value="opaque_123",
                    domain=".example.com",
                    sameSite="none",
                ),
                SetCookie(
                    name="authfn.csrf",
                    value="csrf_123",
                    domain=".example.com",
                    httpOnly=False,
                    sameSite="strict",
                ),
            ],
            body={"ok": True},
        )

    routes = [
        Route(
            method=HttpMethod.POST,
            path="/auth/session",
            handler=create_session,
            meta={
                "auth": {"mode": "cookie-session", "csrf": True},
                "openapi": {
                    "operationId": "createSession",
                    "summary": "Create session",
                    "tags": ["auth", "session"],
                },
            },
        )
    ]
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(routes, url_prefix="/api"))

    client = app.test_client()
    response = client.post("/api/auth/session")

    set_cookie_headers = response.headers.getlist("Set-Cookie")
    assert len(set_cookie_headers) == 2
    assert "Domain=example.com" in set_cookie_headers[0]
    assert "SameSite=None" in set_cookie_headers[0]
    assert "HttpOnly" in set_cookie_headers[0]
    assert "Domain=example.com" in set_cookie_headers[1]
    assert "SameSite=Strict" in set_cookie_headers[1]
    assert "HttpOnly" not in set_cookie_headers[1]

    preserved_handler = app.view_functions["superfunctions.post_auth_session"]
    preserved = getattr(preserved_handler, SUPERFUNCTIONS_ROUTE_ATTR)
    assert preserved.meta is not None
    assert preserved.meta.openapi is not None
    assert preserved.meta.openapi.operation_id == "createSession"

    assert generate_openapi_document("Auth API", "1.0.0", [preserved])["paths"] == {
        "/auth/session": {
            "post": {
                "operationId": "createSession",
                "summary": "Create session",
                "tags": ["auth", "session"],
                "responses": {"200": {"description": "Success"}},
            }
        }
    }
