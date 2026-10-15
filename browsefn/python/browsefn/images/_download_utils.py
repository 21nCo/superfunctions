from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import ImageDownloadOptions


def resolve_download_path(url: str, options: ImageDownloadOptions, *, default_name: str = "downloaded-image") -> Path:
    destination_root = Path(options.destination or ".").resolve()
    destination_root.mkdir(parents=True, exist_ok=True)

    requested_name = options.filename or Path(urlparse(url).path).name or default_name
    if requested_name in {".", ".."} or "/" in requested_name or "\\" in requested_name:
        raise BrowseFnError("SECURITY_POLICY_BLOCKED", "Destination filename must stay within the destination directory.")
    if not options.filename and options.format:
        requested_name = str(Path(requested_name).with_suffix("." + options.format))
    path = destination_root / requested_name

    try:
        path.relative_to(destination_root)
    except ValueError as error:
        raise BrowseFnError(
            "SECURITY_POLICY_BLOCKED",
            "Destination filename must stay within the destination directory.",
        ) from error

    path.parent.mkdir(parents=True, exist_ok=True)
    return path


async def fetch_image_bytes(url: str, options: ImageDownloadOptions) -> bytes:
    """Resolve once per hop, validate all answers, then connect to the checked IP."""
    import asyncio
    return await asyncio.wait_for(_fetch_image_bytes(url, options), timeout=30)


async def _fetch_image_bytes(url: str, options: ImageDownloadOptions) -> bytes:
    import asyncio
    import socket
    import httpx
    from urllib.parse import urljoin

    async with httpx.AsyncClient(timeout=30, trust_env=False, follow_redirects=False, limits=httpx.Limits(max_keepalive_connections=0)) as client:
        for redirects in range(options.max_redirects + 1):
            parsed = httpx.URL(url)
            if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or not parsed.host:
                raise BrowseFnError("SECURITY_POLICY_BLOCKED", "Target URL is not allowed by the active security policy.")
            addresses = await asyncio.get_running_loop().getaddrinfo(
                parsed.host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM,
            )
            if not addresses or (not options.allow_private_hosts and any(not is_public_address(item[4][0]) for item in addresses)):
                raise BrowseFnError("SECURITY_POLICY_BLOCKED", "Target host is not allowed by the active security policy.")
            address = addresses[0][4][0]
            target = parsed.copy_with(host=address)
            # Preserve the original authority and TLS certificate/SNI identity while pinning DNS.
            async with client.stream("GET", target, headers={"Host": parsed.netloc.decode(), "Accept-Encoding": "identity"},
                                     extensions={"sni_hostname": parsed.host}) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    if redirects >= options.max_redirects:
                        raise BrowseFnError("SECURITY_POLICY_BLOCKED", "Redirect limit exceeded for image download.")
                    location = response.headers.get("location")
                    if not location:
                        raise BrowseFnError("PROVIDER_ERROR", "Redirect response did not include a location header.")
                    url = urljoin(url, location)
                    continue
                response.raise_for_status()
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    raise BrowseFnError("PROVIDER_ERROR", "Encoded image responses are not supported.")
                length = response.headers.get("content-length", "")
                if length.isdigit() and int(length) > options.max_payload_bytes:
                    raise BrowseFnError("DOWNLOAD_TOO_LARGE", "Image payload exceeds the configured maximum size.")
                content = bytearray()
                async for chunk in response.aiter_raw():
                    if len(content) + len(chunk) > options.max_payload_bytes:
                        raise BrowseFnError("DOWNLOAD_TOO_LARGE", "Image payload exceeds the configured maximum size.")
                    content.extend(chunk)
                return bytes(content)
    raise BrowseFnError("SECURITY_POLICY_BLOCKED", "Redirect limit exceeded for image download.")


def write_image(path: Path, content: bytes, overwrite: bool | None) -> None:
    """Publish atomically. The destination directory must be application-owned."""
    import os
    import tempfile
    descriptor, temporary = tempfile.mkstemp(prefix=".browsefn-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if overwrite is False:
            try:
                os.link(temporary, path)
            except FileExistsError as error:
                raise BrowseFnError("DOWNLOAD_EXISTS", "Destination file already exists and overwrite is disabled.") from error
        else:
            os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def is_public_address(address: str) -> bool:
    """Conservative address policy stable across supported Python versions."""
    import ipaddress
    ip = ipaddress.ip_address(address)
    if ip.version == 4:
        excluded = ("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
                    "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
                    "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
                    "224.0.0.0/4", "240.0.0.0/4")
    else:
        if ip not in ipaddress.ip_network("2000::/3"):
            return False
        excluded = ("2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20")
    return not any(ip in ipaddress.ip_network(network) for network in excluded)
