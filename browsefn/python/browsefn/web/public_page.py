"""Protected static page transport: resolve once, validate all answers, pin each hop."""
import asyncio
import socket
from urllib.parse import urljoin
from typing import Tuple

import httpx

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import GetPageOptions
from browsefn.images._download_utils import is_public_address


def denied() -> BrowseFnError:
    return BrowseFnError("SECURITY_POLICY_BLOCKED", "Target is not allowed by the active destination policy.")


async def fetch_public_page(url: str, options: GetPageOptions) -> Tuple[str, str]:
    if options.proxy or options.cookies:
        raise denied()
    try:
        return await asyncio.wait_for(_fetch(url, options), timeout=(options.timeout or 30000) / 1000)
    except asyncio.TimeoutError as error:
        raise BrowseFnError("UPSTREAM_TIMEOUT", "Page request timed out.") from error


async def _fetch(url: str, options: GetPageOptions) -> Tuple[str, str]:
    headers = dict(options.headers or {})
    allow_private = options.security is not None and options.security.allow_private_hosts
    async with httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                 limits=httpx.Limits(max_keepalive_connections=0)) as client:
        for redirects in range(6):
            parsed = httpx.URL(url)
            if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or not parsed.host:
                raise denied()
            addresses = await asyncio.get_running_loop().getaddrinfo(
                parsed.host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
            if not addresses or (not allow_private and any(not is_public_address(item[4][0]) for item in addresses)):
                raise denied()
            target = parsed.copy_with(host=addresses[0][4][0])
            safe_headers = {key: value for key, value in headers.items() if key.lower() not in {"host", "accept-encoding"}}
            safe_headers.update({"Host": parsed.netloc.decode(), "Accept-Encoding": "identity"})
            async with client.stream("GET", target, headers=safe_headers, extensions={"sni_hostname": parsed.host}) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    if redirects == 5 or not response.headers.get("location"):
                        raise denied()
                    next_url = httpx.URL(urljoin(url, response.headers["location"]))
                    if (next_url.scheme, next_url.host, next_url.port) != (parsed.scheme, parsed.host, parsed.port):
                        headers = {}
                    url = str(next_url)
                    continue
                response.raise_for_status()
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    raise BrowseFnError("PROVIDER_ERROR", "Encoded page responses are not supported.")
                content = bytearray()
                maximum = 10 * 1024 * 1024
                length = response.headers.get("content-length", "")
                if length.isdigit() and int(length) > maximum:
                    raise BrowseFnError("DOWNLOAD_TOO_LARGE", "Page payload exceeds the configured maximum size.")
                async for chunk in response.aiter_raw():
                    if len(content) + len(chunk) > maximum:
                        raise BrowseFnError("DOWNLOAD_TOO_LARGE", "Page payload exceeds the configured maximum size.")
                    content.extend(chunk)
                return bytes(content).decode("utf-8", errors="replace"), str(parsed)
    raise denied()
