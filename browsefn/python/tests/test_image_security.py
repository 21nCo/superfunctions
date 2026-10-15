from __future__ import annotations

import asyncio
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import ImageDownloadOptions
from browsefn.images.browser import ImageBrowser
from browsefn.images.providers.unsplash import UnsplashProvider

from io import BytesIO
from PIL import Image
_buffer = BytesIO()
Image.new("RGB", (1, 1), "red").save(_buffer, format="JPEG")
JPEG = _buffer.getvalue()


@pytest.fixture
def server():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            calls.append((self.path, self.headers.get('Host')))
            if self.path in {'/redirect', '/loop', '/scheme'}:
                self.send_response(302)
                self.send_header('Location', {'/redirect': '/image.jpg', '/loop': '/loop', '/scheme': 'file:///etc/passwd'}[self.path])
                self.end_headers()
                return
            self.send_response(200)
            if self.path == '/declared':
                self.send_header('Content-Length', '99999999')
            self.end_headers()
            self.wfile.write(b'x' * 128 if self.path in {'/large', '/declared'} else JPEG)

    instance = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{instance.server_port}', calls
    instance.shutdown()
    instance.server_close()
    thread.join()


@pytest.mark.asyncio
async def test_download_and_provider_actual_http(server, tmp_path):
    base, calls = server
    options = ImageDownloadOptions(destination=str(tmp_path), allowPrivateHosts=True, metadata=True)
    result = await ImageBrowser().download(base + '/redirect', options)
    assert result.success and Path(result.path).read_bytes() == JPEG
    assert result.metadata.width == 1
    provider = await UnsplashProvider().download(base + '/image.jpg', options)
    assert provider.success and Path(provider.path).read_bytes() == JPEG
    assert all(authority == base.removeprefix('http://') for _, authority in calls)


@pytest.mark.asyncio
async def test_dns_and_ipv6_blocked_before_http(server, tmp_path):
    base, calls = server
    port = base.rsplit(':', 1)[-1]
    for host in ['localhost.', '127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '[fe80::1]']:
        with pytest.raises(BrowseFnError, match='not allowed'):
            await ImageBrowser().download(f'http://{host}:{port}/image.jpg', ImageDownloadOptions(destination=str(tmp_path)))
    assert calls == []


@pytest.mark.asyncio
async def test_redirect_and_payload_limits(server, tmp_path):
    base, _ = server
    for route, code in [('loop', 'SECURITY_POLICY_BLOCKED'), ('scheme', 'SECURITY_POLICY_BLOCKED'), ('large', 'DOWNLOAD_TOO_LARGE'), ('declared', 'DOWNLOAD_TOO_LARGE')]:
        with pytest.raises(BrowseFnError) as raised:
            await ImageBrowser().download(base + '/' + route, ImageDownloadOptions(destination=str(tmp_path), allowPrivateHosts=True, maxPayloadBytes=64, maxRedirects=2))
        assert raised.value.code == code
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_concurrent_no_overwrite_and_link_targets(server, tmp_path):
    base, _ = server
    options = ImageDownloadOptions(destination=str(tmp_path), allowPrivateHosts=True, overwrite=False)
    results = await asyncio.gather(*(ImageBrowser().download(base + '/image.jpg', options) for _ in range(2)), return_exceptions=True)
    assert sum(not isinstance(result, Exception) for result in results) == 1
    assert any(isinstance(result, BrowseFnError) and result.code == 'DOWNLOAD_EXISTS' for result in results)
    outside = tmp_path / 'outside'
    outside.write_bytes(b'keep')
    for name, link in [('symbol.jpg', os.symlink), ('hard.jpg', os.link)]:
        link(outside, tmp_path / name)
        await ImageBrowser().download(base + '/' + name, ImageDownloadOptions(destination=str(tmp_path), allowPrivateHosts=True))
        assert outside.read_bytes() == b'keep'
    assert not list(tmp_path.glob('.browsefn-*'))


def test_address_policy_and_option_validation():
    from browsefn.images._download_utils import is_public_address
    from pydantic import ValidationError
    for address in ["100.64.0.1", "169.254.169.254", "192.0.0.9", "224.0.0.1", "fc00::1", "2001:db8::1", "2002:7f00:1::"]:
        assert not is_public_address(address)
    for address in ["8.8.8.8", "2606:4700:4700::1111"]:
        assert is_public_address(address)
    for options in [{"maxPayloadBytes": 0}, {"maxRedirects": -1}, {"maxRedirects": 1.5}]:
        with pytest.raises(ValidationError):
            ImageDownloadOptions(**options)


@pytest.mark.asyncio
async def test_explicit_provider_size_url_uses_real_selected_endpoint(server, tmp_path):
    from browsefn.core.browse_fn import BrowseFn
    from browsefn.core.types import ImageResult, ImageSource, ImageDownloads
    base, calls = server
    image = ImageResult(id="1", url=base + "/default", thumbnail="", width=1, height=1,
                        source=ImageSource(provider="test", url=base + "/page"),
                        downloads=ImageDownloads(small=base + "/small.jpg"))
    result = await BrowseFn().images.download(image, ImageDownloadOptions(destination=str(tmp_path), size="small", allowPrivateHosts=True))
    assert result.success and Path(result.path).name == "small.jpg"
    assert [path for path, _ in calls] == ["/small.jpg"]
