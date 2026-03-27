"""Flask adapter for PlugFn."""

import asyncio
from inspect import isawaitable
from typing import Any, Optional

try:
    from flask import Blueprint, jsonify, request
except ImportError:
    raise ImportError(
        "Flask is required for this adapter. Install it with: pip install plugfn[flask]"
    )


class AdapterSecurityError(Exception):
    """Deterministic adapter-layer security error."""

    def __init__(
        self, code: str, message: str, status_code: int, details: Optional[dict[str, Any]] = None
    ):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.details = details or {}


def mount_plugfn(
    app: Any,
    plug: Any,
    prefix: str = "/api/plugfn",
    auth: Optional[Any] = None,
) -> Blueprint:
    """Mount PlugFn routes to a Flask app."""
    bp = Blueprint("plugfn", __name__, url_prefix=prefix)

    def run_async(coro: Any) -> Any:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    @bp.route("/connections/auth", methods=["POST"])
    def create_connection_auth():
        return run_async(_handle_auth_url_request(plug, auth))

    @bp.route("/auth/<provider>", methods=["GET"])
    def legacy_get_auth_url(provider: str):
        return run_async(_handle_auth_url_request(plug, auth, provider_override=provider))

    @bp.route("/callback", methods=["GET"])
    def canonical_callback():
        provider = request.values.get("provider")
        code = request.values.get("code")
        state = request.values.get("state")
        return run_async(_handle_callback(provider, code, state, plug))

    @bp.route("/auth/<provider>/callback", methods=["GET"])
    def legacy_callback(provider: str):
        code = request.values.get("code")
        state = request.values.get("state")
        return run_async(_handle_callback(provider, code, state, plug))

    @bp.route("/connections", methods=["GET"])
    def list_connections():
        try:
            provider = request.values.get("provider")
            principal = run_async(_resolve_principal(request, plug, auth))
            requested_user_id = request.values.get("user_id") or request.values.get("userId")
            _assert_identity_match(principal, requested_user_id)
            connections = run_async(
                plug.connections.list(user_id=principal["user_id"], provider=provider)
            )

            return _success(
                {
                    "userId": principal["user_id"],
                    "connections": [
                        {
                            "id": connection.id,
                            "provider": connection.provider,
                            "name": connection.name,
                            "status": connection.status,
                            "connected_at": connection.connected_at.isoformat(),
                        }
                        for connection in connections
                    ],
                }
            )
        except Exception as error:
            return _error_from_exception(error)

    @bp.route("/connections/disconnect", methods=["POST"])
    def disconnect_connection():
        try:
            payload = request.get_json(silent=False)
            if not isinstance(payload, dict):
                raise AdapterSecurityError("VALIDATION_ERROR", "JSON body must be an object", 400)

            principal = run_async(_resolve_principal(request, plug, auth))
            requested_user_id = payload.get("user_id") or payload.get("userId")
            _assert_identity_match(principal, requested_user_id)

            connection_id = payload.get("connection_id") or payload.get("connectionId")
            if not isinstance(connection_id, str) or not connection_id:
                raise AdapterSecurityError(
                    "VALIDATION_ERROR",
                    "connection_id is required",
                    400,
                )

            run_async(
                plug.connections.disconnect(
                    connection_id=connection_id, user_id=principal["user_id"]
                )
            )

            return _success(
                {
                    "connectionId": connection_id,
                    "disconnected": True,
                }
            )
        except Exception as error:
            return _error_from_exception(error)

    @bp.route("/connections/<connection_id>", methods=["DELETE"])
    def legacy_disconnect(connection_id: str):
        try:
            principal = run_async(_resolve_principal(request, plug, auth))
            run_async(
                plug.connections.disconnect(
                    connection_id=connection_id, user_id=principal["user_id"]
                )
            )
            return _success(
                {
                    "connectionId": connection_id,
                    "disconnected": True,
                }
            )
        except Exception as error:
            return _error_from_exception(error)

    @bp.route("/webhooks/<provider>/<event>", methods=["POST"])
    def handle_webhook(provider: str, event: str):
        try:
            raw_body = request.get_data(cache=True, as_text=False)
            headers = _normalize_headers(dict(request.headers))
            secret = _resolve_webhook_secret(plug, provider)

            results = run_async(
                plug._webhook_handler.handle_webhook(
                    provider=provider,
                    event=event,
                    payload=None,
                    headers=headers,
                    secret=secret,
                    raw_body=raw_body,
                )
            )

            return _success({"results": results})
        except Exception as error:
            return _error_from_exception(error)

    @bp.route("/providers", methods=["GET"])
    def list_providers():
        try:
            run_async(_resolve_principal(request, plug, auth))
            providers = plug.providers.list()
            return _success(
                {
                    "providers": [
                        {
                            "name": provider.name,
                            "display_name": provider.display_name,
                            "description": provider.description,
                            "auth_type": provider.auth_type,
                            "version": provider.version,
                        }
                        for provider in providers
                    ]
                }
            )
        except Exception as error:
            return _error_from_exception(error)

    app.register_blueprint(bp)
    return bp


async def _handle_auth_url_request(
    plug: Any,
    auth_override: Optional[Any],
    provider_override: Optional[str] = None,
):
    try:
        if request.method == "POST":
            payload = request.get_json(silent=False)
            if not isinstance(payload, dict):
                raise AdapterSecurityError("VALIDATION_ERROR", "JSON body must be an object", 400)
            provider = provider_override or payload.get("provider")
            redirect_uri = payload.get("redirect_uri") or payload.get("redirectUri")
            scopes_value = payload.get("scopes")
            requested_user_id = payload.get("user_id") or payload.get("userId")
            connection_name = payload.get("connection_name") or payload.get("connectionName")
        else:
            provider = provider_override or request.values.get("provider")
            redirect_uri = request.values.get("redirect_uri")
            scopes_value = request.values.get("scopes")
            requested_user_id = request.values.get("user_id") or request.values.get("userId")
            connection_name = request.values.get("connection_name") or request.values.get(
                "connectionName"
            )

        if not isinstance(provider, str) or not provider:
            raise AdapterSecurityError("VALIDATION_ERROR", "provider is required", 400)
        if not isinstance(redirect_uri, str) or not redirect_uri:
            raise AdapterSecurityError("VALIDATION_ERROR", "redirect_uri is required", 400)

        principal = await _resolve_principal(request, plug, auth_override)
        _assert_identity_match(principal, requested_user_id)

        scopes = _normalize_scopes(scopes_value)
        url = await plug.connections.get_auth_url(
            provider=provider,
            user_id=principal["user_id"],
            redirect_uri=redirect_uri,
            scopes=scopes,
            connection_name=connection_name,
        )

        return _success(
            {
                "url": url,
                "userId": principal["user_id"],
            }
        )
    except Exception as error:
        return _error_from_exception(error)


async def _handle_callback(provider: Any, code: Any, state: Any, plug: Any):
    try:
        if not isinstance(provider, str) or not provider:
            raise AdapterSecurityError("VALIDATION_ERROR", "provider is required", 400)
        if not isinstance(code, str) or not code or not isinstance(state, str) or not state:
            raise AdapterSecurityError("VALIDATION_ERROR", "code and state are required", 400)

        connection = await plug.connections.handle_callback(
            provider=provider, code=code, state=state
        )
        return _success(
            {
                "connection": {
                    "id": connection.id,
                    "provider": connection.provider,
                    "status": connection.status,
                }
            }
        )
    except Exception as error:
        return _error_from_exception(error)


async def _resolve_principal(request_obj: Any, plug: Any, auth_override: Optional[Any]) -> dict[str, Any]:
    auth_provider = auth_override or getattr(getattr(plug, "config", None), "auth", None)
    if auth_provider is None:
        raise AdapterSecurityError(
            "PLUGFN_AUTH_REQUIRED",
            "Authentication is required",
            401,
        )

    principal = await _invoke_auth_provider(auth_provider, request_obj)
    normalized = _normalize_principal(principal)
    if normalized is None:
        raise AdapterSecurityError(
            "PLUGFN_AUTH_REQUIRED",
            "Authentication is required",
            401,
        )
    return normalized


async def _invoke_auth_provider(auth_provider: Any, request_obj: Any) -> Any:
    for attribute in ("authenticate", "require_auth", "requireAuth", "get_user_id", "getUserId"):
        method = getattr(auth_provider, attribute, None)
        if callable(method):
            result = method(request_obj)
            if isawaitable(result):
                return await result
            return result

    if callable(auth_provider):
        result = auth_provider(request_obj)
        if isawaitable(result):
            return await result
        return result

    return None


def _normalize_principal(principal: Any) -> Optional[dict[str, Any]]:
    if principal is None:
        return None

    if isinstance(principal, str):
        return {"user_id": principal}

    if isinstance(principal, dict):
        user_id = principal.get("user_id") or principal.get("userId")
        if isinstance(user_id, str) and user_id:
            return {
                "user_id": user_id,
                "tenant_id": principal.get("tenant_id") or principal.get("tenantId"),
            }

    return None


def _assert_identity_match(principal: dict[str, Any], requested_user_id: Any) -> None:
    if requested_user_id is None:
        return

    if requested_user_id != principal["user_id"]:
        raise AdapterSecurityError(
            "TENANT_ACCESS_DENIED",
            "Caller identity does not match the authenticated principal",
            403,
            {"userId": principal["user_id"]},
        )


def _normalize_scopes(value: Any) -> Optional[list[str]]:
    if value is None:
        return None
    if isinstance(value, list):
        scopes = [scope for scope in value if isinstance(scope, str) and scope]
        return scopes or None
    if isinstance(value, str):
        scopes = [scope.strip() for scope in value.split(",") if scope.strip()]
        return scopes or None
    return None


def _resolve_webhook_secret(plug: Any, provider: str) -> Optional[str]:
    connection_manager = getattr(plug, "_connection_manager", None)
    if connection_manager and hasattr(connection_manager, "resolve_webhook_secret"):
        return connection_manager.resolve_webhook_secret(provider)

    integrations = getattr(getattr(plug, "config", None), "integrations", {}) or {}
    provider_config = integrations.get(provider, {})
    for key in ("webhook_secret", "signing_secret", "webhookSigningSecret", "signingSecret"):
        value = provider_config.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _normalize_headers(headers: dict[str, Any]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key, value in headers.items():
        if isinstance(value, str):
            normalized[key.lower()] = value
    return normalized


def _success(data: dict[str, Any], status_code: int = 200):
    return jsonify({"ok": True, "data": data}), status_code


def _error_from_exception(error: Exception):
    if isinstance(error, AdapterSecurityError):
        return (
            jsonify(
                {
                    "ok": False,
                    "error": {
                        "code": error.code,
                        "message": str(error),
                        "status": error.status_code,
                        "details": error.details,
                    },
                }
            ),
            error.status_code,
        )

    error_code = getattr(error, "code", "VALIDATION_ERROR")
    status_code = getattr(error, "status", 400)
    return (
        jsonify(
            {
                "ok": False,
                "error": {
                    "code": error_code,
                    "message": str(error),
                    "status": status_code,
                    "details": {},
                },
            }
        ),
        status_code,
    )
