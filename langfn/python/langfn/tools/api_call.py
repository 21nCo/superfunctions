from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from ..models.transport import get_async_client
from .base import Tool, ToolContext
from .policy import enforce_outbound_policy, resolve_secret


class ApiCallArgs(BaseModel):
    url: str = Field(..., description="The URL to call")
    method: str = Field("GET", description="The HTTP method")
    headers: dict[str, str] = Field(default_factory=dict, description="HTTP headers")
    body: Any = Field(None, description="Request body")
    auth_secret_ref: Optional[str] = Field(None, description="Optional secret ref for Authorization header")


async def execute_api_call(args: ApiCallArgs, context: ToolContext) -> Any:
    policy = context.policy
    enforce_outbound_policy(
        args.url,
        allow_private_network=policy.allow_private_network,
        allowed_hosts=policy.allowed_hosts,
    )

    headers = dict(args.headers)
    if args.auth_secret_ref:
        secret = resolve_secret(args.auth_secret_ref, policy.secret_provider)
        if secret:
            headers.setdefault("Authorization", f"Bearer {secret}")

    parsed = urlsplit(args.url)
    client = get_async_client(
        base_url=f"{parsed.scheme}://{parsed.netloc}",
        headers={},
        timeout=30.0,
    )
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"

    request_kwargs: dict[str, Any] = {
        "method": args.method.upper(),
        "url": target,
        "headers": headers,
    }
    if isinstance(args.body, (dict, list)):
        request_kwargs["json"] = args.body
    elif args.body is not None:
        request_kwargs["content"] = args.body

    resp = await client.request(**request_kwargs)
    content_type = resp.headers.get("content-type", "")
    if "application/json" in content_type:
        return resp.json()
    return resp.text


def ApiCallTool() -> Tool[ApiCallArgs, Any]:
    return Tool(
        name="api_call",
        description="Make an HTTP API call to a remote service.",
        args_schema=ApiCallArgs,
        execute=execute_api_call,
    )
