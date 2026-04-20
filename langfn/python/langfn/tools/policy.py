from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Mapping, Optional, Sequence
from urllib.parse import urlparse

from ..core.errors import NotConfiguredError, ToolDisabledError, ToolPolicyViolationError

SecretProvider = Callable[[str], Optional[str]]
OutputSanitizer = Callable[[Any], Any]
SandboxExecutor = Callable[[str], Any]
SearchBackend = Callable[[str], Any]


def redact_sensitive_fields(payload: Any, sensitive_keys: Sequence[str] = ("authorization", "ssn")) -> Any:
    sensitive = {key.lower() for key in sensitive_keys}
    if isinstance(payload, dict):
        return {
            key: ("***REDACTED***" if key.lower() in sensitive else redact_sensitive_fields(value, sensitive_keys))
            for key, value in payload.items()
        }
    if isinstance(payload, list):
        return [redact_sensitive_fields(item, sensitive_keys) for item in payload]
    return payload


def sanitize_output(value: Any) -> Any:
    if isinstance(value, str):
        if re.search(r"<\s*script\b", value, flags=re.IGNORECASE):
            return "safe string"
        return value
    if isinstance(value, dict):
        return {key: sanitize_output(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_output(item) for item in value]
    return value


def resolve_secret(secret_ref: Optional[str], provider: Optional[SecretProvider]) -> Optional[str]:
    if secret_ref is None:
        return None
    if provider is None:
        raise NotConfiguredError("Secret provider is required", metadata={"secret_ref": secret_ref})
    secret = provider(secret_ref)
    if secret is None:
        raise NotConfiguredError("Required secret is missing", metadata={"secret_ref": secret_ref})
    return secret


def enforce_outbound_policy(url: str, allow_private_network: bool = False, allowed_hosts: Sequence[str] = ()) -> None:
    parsed = urlparse(url)
    host = parsed.hostname
    if host is None:
        raise ToolPolicyViolationError("API call target must include a hostname", metadata={"url": url})

    if host in set(allowed_hosts):
        return

    lowered = host.lower()
    if lowered in {"localhost", "metadata.google.internal"}:
        if not allow_private_network:
            raise ToolPolicyViolationError("Blocked outbound destination", metadata={"host": host, "url": url})
        return

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return

    blocked = (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or str(ip) == "169.254.169.254"
    )
    if blocked and not allow_private_network:
        raise ToolPolicyViolationError("Blocked outbound destination", metadata={"host": host, "url": url})


@dataclass(frozen=True)
class ToolPolicy:
    secret_provider: Optional[SecretProvider] = None
    sanitizer: OutputSanitizer = sanitize_output
    allowed_hosts: Sequence[str] = field(default_factory=tuple)
    allow_private_network: bool = False
    sandbox_executor: Optional[SandboxExecutor] = None
    search_backend: Optional[SearchBackend] = None
    redact_keys: Sequence[str] = field(default_factory=lambda: ("authorization", "ssn"))

    def sanitize(self, value: Any) -> Any:
        return self.sanitizer(value)

    def redact(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        return redact_sensitive_fields(dict(payload), self.redact_keys)

    def require_search_backend(self) -> SearchBackend:
        if self.search_backend is None:
            raise NotConfiguredError("Web search backend is not configured")
        return self.search_backend

    def require_sandbox(self) -> SandboxExecutor:
        if self.sandbox_executor is None:
            raise ToolDisabledError("Code execution sandbox is disabled")
        return self.sandbox_executor
