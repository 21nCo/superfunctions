from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

from superfunctions.auth import AuthProvider, AuthSession, validate_auth_session
from superfunctions.http import Request, Response

from .validation import LangFnRouteContext, error_envelope


@dataclass
class LangFnAuthConfig:
    provider: Optional[AuthProvider] = None
    validate_bearer_token: Optional[Callable[[str, Request], Awaitable[Optional[AuthSession]] | Optional[AuthSession]]] = None
    header_name: str = "authorization"


def create_auth_middleware(config: Optional[LangFnAuthConfig] = None):
    if config is None or (config.provider is None and config.validate_bearer_token is None):
        async def passthrough(_request: Request, _context: LangFnRouteContext, next_handler):
            return await next_handler(_request, _context)

        return passthrough

    async def middleware(request: Request, context: LangFnRouteContext, next_handler):
        try:
            session = await _authenticate(request, config)
        except Exception:
            session = None

        if session is None:
            return Response(
                status=401,
                headers={"content-type": "application/json"},
                body=error_envelope("AUTH_REQUIRED", "Authentication required"),
            )

        context.auth = validate_auth_session(session) if isinstance(session, dict) else session
        return await next_handler(request, context)

    return middleware


async def _authenticate(request: Request, config: LangFnAuthConfig) -> Optional[AuthSession]:
    if config.provider is not None:
        return await config.provider.authenticate(request)

    token = extract_bearer_token(request, header_name=config.header_name)
    if token is None or config.validate_bearer_token is None:
        return None
    result = config.validate_bearer_token(token, request)
    if hasattr(result, "__await__"):
        return await result
    return result


def extract_bearer_token(request: Request, *, header_name: str = "authorization") -> Optional[str]:
    for key, value in request.headers.items():
        if key.lower() != header_name.lower():
            continue
        parts = str(value).strip().split(" ", 1)
        if len(parts) == 2 and parts[0].lower() == "bearer" and parts[1].strip():
            return parts[1].strip()
    return None
