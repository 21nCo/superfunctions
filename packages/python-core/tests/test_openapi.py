from __future__ import annotations

import pytest

from superfunctions.http import Response, Route, SetCookie, serialize_response_cookies
from superfunctions.http.openapi import OpenApiGenerationError, generate_openapi_document
from superfunctions.http.types import HttpMethod


def test_generate_openapi_document_is_deterministic() -> None:
    routes = [
        Route(
            method=HttpMethod.POST,
            path="/auth/session",
            handler=lambda request, context: Response(status=201, body={}),
            meta={
                "openapi": {
                    "operationId": "createSession",
                    "summary": "Create session",
                    "tags": ["session", "auth"],
                    "requestBodySchema": {
                        "type": "object",
                        "required": ["email"],
                        "properties": {
                            "password": {"type": "string"},
                            "email": {"type": "string"},
                        },
                    },
                    "responseSchemas": {
                        "201": {
                            "type": "object",
                            "properties": {
                                "sessionId": {"type": "string"},
                                "userId": {"type": "string"},
                            },
                        }
                    },
                }
            },
        ),
        Route(
            method=HttpMethod.GET,
            path="/users/:user_id",
            handler=lambda request, context: Response(status=200, body={}),
            meta={
                "openapi": {
                    "operationId": "getUser",
                    "tags": ["users", "auth"],
                }
            },
        ),
    ]

    document = generate_openapi_document("Auth API", "1.0.0", routes)

    assert document == {
        "openapi": "3.1.0",
        "info": {"title": "Auth API", "version": "1.0.0"},
        "paths": {
            "/auth/session": {
                "post": {
                    "operationId": "createSession",
                    "summary": "Create session",
                    "tags": ["auth", "session"],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "properties": {
                                        "email": {"type": "string"},
                                        "password": {"type": "string"},
                                    },
                                    "required": ["email"],
                                    "type": "object",
                                }
                            }
                        },
                    },
                    "responses": {
                        "201": {
                            "description": "HTTP 201 response",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "properties": {
                                            "sessionId": {"type": "string"},
                                            "userId": {"type": "string"},
                                        },
                                        "type": "object",
                                    }
                                }
                            },
                        }
                    },
                }
            },
            "/users/{user_id}": {
                "get": {
                    "operationId": "getUser",
                    "tags": ["auth", "users"],
                    "responses": {
                        "200": {
                            "description": "Success",
                        }
                    },
                }
            },
        },
    }


def test_generate_openapi_document_fails_for_missing_operation_id() -> None:
    routes = [
        Route(
            method=HttpMethod.GET,
            path="/auth/session",
            handler=lambda request, context: Response(status=200, body={}),
            meta={
                "openapi": {
                    "include": True,
                    "summary": "Read session",
                }
            },
        )
    ]

    with pytest.raises(OpenApiGenerationError) as exc_info:
        generate_openapi_document("Broken API", "1.0.0", routes)

    assert exc_info.value.code == "OPENAPI_META_INCOMPLETE"
    assert exc_info.value.details == {"method": "GET", "path": "/auth/session"}


def test_python_http_preserves_repeated_cookies_for_openapi_phase() -> None:
    response = Response(
        cookies=[
            SetCookie(name="__Secure-authfn.session", value="opaque_1"),
            SetCookie(name="authfn.csrf", value="csrf_1", httpOnly=False),
        ]
    )

    assert serialize_response_cookies(response) == [
        "__Secure-authfn.session=opaque_1; Path=/; Secure; HttpOnly; SameSite=Lax",
        "authfn.csrf=csrf_1; Path=/; Secure; SameSite=Lax",
    ]
