from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Protocol

from superfunctions.auth import AuthSession
from superfunctions.http import Request, Response

from .validation import CanonicalTenantContext, LangFnRouteContext, error_envelope, extract_tenant_context


@dataclass
class RateLimitDecision:
    allowed: bool
    key: str
    remaining: Optional[int] = None
    retry_after_ms: Optional[int] = None


class RateLimitProvider(Protocol):
    async def consume(self, payload: dict[str, Any]) -> RateLimitDecision:
        ...


@dataclass
class LangFnRateLimitConfig:
    provider: Optional[RateLimitProvider] = None


def create_rate_limit_middleware(
    *,
    route_id: str,
    config: Optional[LangFnRateLimitConfig] = None,
    get_tenant_context: Optional[Callable[[Request, Optional[AuthSession]], CanonicalTenantContext]] = None,
):
    if config is None or config.provider is None:
        async def passthrough(_request: Request, _context: LangFnRouteContext, next_handler):
            return await next_handler(_request, _context)

        return passthrough

    resolver = get_tenant_context or extract_tenant_context

    async def middleware(request: Request, context: LangFnRouteContext, next_handler):
        tenant_context = resolver(request, context.auth)
        context.tenant_context = tenant_context
        session = context.auth
        key = ":".join(
            [
                tenant_context.tenant_id or "anonymous",
                tenant_context.user_id or (session.subject.actor_id if session is not None else "anonymous"),
                route_id,
            ]
        )
        decision = await config.provider.consume(
            {
                "key": key,
                "route_id": route_id,
                "tenant_context": tenant_context,
                "request": request,
                "session": session,
            }
        )
        context.rate_limit = {
            "allowed": decision.allowed,
            "key": decision.key,
            "remaining": decision.remaining,
            "retry_after_ms": decision.retry_after_ms,
        }
        if decision.allowed:
            return await next_handler(request, context)

        headers = {"content-type": "application/json"}
        if decision.retry_after_ms is not None:
            headers["retry-after"] = str(max(1, int((decision.retry_after_ms + 999) / 1000)))
        return Response(
            status=429,
            headers=headers,
            body=error_envelope(
                "RATE_LIMITED",
                "Rate limit exceeded",
                {
                    "key": decision.key,
                    "remaining": decision.remaining,
                    "retryAfterMs": decision.retry_after_ms,
                },
            ),
        )

    return middleware
