"""Exact host rules shared by local page and image transports."""
import ipaddress
import re
from typing import Optional
import httpx
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import DestinationSecurity


def normalize_policy_host(value: str) -> str:
    def invalid():
        return BrowseFnError("INVALID_ARGUMENT", "Security host rules must be exact hostnames or IP addresses.")
    if not isinstance(value, str) or not value or re.search(r"[\s/@?#\\%*]", value):
        raise invalid()
    host = value[:-1] if value.endswith(".") else value
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    try:
        address = ipaddress.ip_address(host)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            mapped = int(address.ipv4_mapped)
            return f"::ffff:{mapped >> 16:x}:{mapped & 65535:x}"
        return address.compressed
    except ValueError:
        pass
    if not host or ":" in host or host.endswith(".") or ".." in host or re.fullmatch(r"[\d.]+", host):
        raise invalid()
    try:
        normalized = httpx.URL("http://" + host + "/").raw_host.decode("ascii").lower()
    except Exception as error:
        raise invalid() from error
    if len(normalized) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label) or len(label) > 63 for label in normalized.split(".")):
        raise invalid()
    # Reject WHATWG numeric IPv4 aliases rather than interpreting them differently by SDK.
    if re.fullmatch(r"(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*", normalized):
        raise invalid()
    return normalized


def normalize_security(value: Optional[DestinationSecurity]) -> Optional[DestinationSecurity]:
    if value is None:
        return None
    def hosts(rules):
        if rules is None:
            return None
        if not isinstance(rules, list) or any(not isinstance(rule, str) for rule in rules):
            raise BrowseFnError("INVALID_ARGUMENT", "Security host rules must be arrays of exact hostnames.")
        return list(dict.fromkeys(normalize_policy_host(rule) for rule in rules))
    fields = {"allowPrivateHosts": value.allow_private_hosts}
    if value.allowed_hosts is not None:
        fields["allowedHosts"] = hosts(value.allowed_hosts)
    if value.blocked_hosts is not None:
        fields["blockedHosts"] = hosts(value.blocked_hosts)
    for field, alias in (("max_response_bytes", "maxResponseBytes"), ("max_download_bytes", "maxDownloadBytes"), ("max_redirects", "maxRedirects")):
        limit = getattr(value, field)
        if limit is not None:
            fields[alias] = limit
    return DestinationSecurity(**fields)


def merge_security(defaults: Optional[DestinationSecurity], override: Optional[DestinationSecurity]) -> Optional[DestinationSecurity]:
    base, call = normalize_security(defaults), normalize_security(override)
    if base is None and call is None:
        return None
    private = call.allow_private_hosts if call is not None and "allow_private_hosts" in override.model_fields_set else (base.allow_private_hosts if base else False)
    limits = {}
    for field, alias in (("max_response_bytes", "maxResponseBytes"), ("max_download_bytes", "maxDownloadBytes"), ("max_redirects", "maxRedirects")):
        values = [getattr(policy, field) for policy in (base, call) if policy is not None and getattr(policy, field) is not None]
        if values:
            limits[alias] = min(values)
    return DestinationSecurity(**limits, allowPrivateHosts=private,
        allowedHosts=call.allowed_hosts if call is not None and "allowed_hosts" in override.model_fields_set else (base.allowed_hosts or [] if base else []),
        blockedHosts=list(dict.fromkeys((base.blocked_hosts or [] if base else []) + (call.blocked_hosts or [] if call else []))))


def permits_private_host(host: str, security: Optional[DestinationSecurity]) -> bool:
    policy = normalize_security(security)
    normalized = normalize_policy_host(host)
    if policy and normalized in (policy.blocked_hosts or []):
        raise BrowseFnError("SECURITY_POLICY_BLOCKED", "Target host is not allowed by the active security policy.")
    return bool(policy and (policy.allow_private_hosts or normalized in (policy.allowed_hosts or [])))


def requires_protected_transport(security: Optional[DestinationSecurity]) -> bool:
    policy = normalize_security(security)
    return policy is not None and (not policy.allow_private_hosts or bool(policy.blocked_hosts) or bool(policy.allowed_hosts) or policy.max_response_bytes is not None or policy.max_redirects is not None)
