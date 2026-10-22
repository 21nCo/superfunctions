"""Owned network fixtures for mandatory router destination enforcement."""
import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import GetPageOptions, DestinationSecurity, ProviderCapabilities
from browsefn.http.router import create_browsefn_router
from browsefn.web.providers.bs4 import BeautifulSoupProvider
from browsefn.web.scraper import WebScraper
from browsefn.web.public_page import fetch_public_page
from test_router import MockRequest, _route


@pytest.fixture
def owned():
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_GET(self):
            calls.append(self.path)
            if self.path == '/slow':
                import time
                time.sleep(0.1)
                return
            if self.path in {'/redirect', '/loop', '/scheme', '/private-redirect'}:
                self.send_response(302)
                self.send_header('Location', {'/redirect': '/page', '/loop': '/loop', '/scheme': 'file:///etc/passwd', '/private-redirect': f'http://127.0.0.2:{self.server.server_port}/private'}[self.path])
                self.end_headers()
                return
            self.send_response(200)
            if self.path == '/encoded':
                self.send_header('Content-Encoding', 'gzip')
            if self.path == '/large':
                self.send_header('Content-Length', '999999999')
            self.end_headers()
            self.wfile.write(b'<html><title>Owned fixture</title><a href="/next">Next</a></html>')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}', calls
    finally:
        server.shutdown(); server.server_close(); thread.join()


def service():
    web = WebScraper()
    web.register_provider('cheerio', BeautifulSoupProvider())
    return web


@pytest.mark.asyncio
async def test_router_private_override_and_metadata_are_denied_without_network(owned):
    base, calls = owned
    routes = create_browsefn_router(SimpleNamespace(web=service()))
    for host in ['127.0.0.1', 'localhost']:
        response = await _route(routes, '/web/page').handler(MockRequest(json_body={'url': base.replace('127.0.0.1', host), 'options': {'security': {'allowPrivateHosts': True}, 'cache': {'key': 'override'}}}), None)
        assert response.status == 403
    response = await _route(routes, '/web/metadata').handler(MockRequest(json_body={'urls': [base], 'options': {'security': {'allowPrivateHosts': True}}}), None)
    assert response.body['data']['results'][0]['success'] is False
    assert calls == []


@pytest.mark.asyncio
async def test_explicit_library_optin_redirects_and_limits(owned):
    base, calls = owned
    options = GetPageOptions(security=DestinationSecurity(allowPrivateHosts=True), includeLinks=True)
    page = await service().get_page(base + '/redirect', options)
    assert page.url == base + '/page'
    assert page.metadata.title == 'Owned fixture'
    assert page.links == [base + '/next']
    for path, code in [('/loop', 'SECURITY_POLICY_BLOCKED'), ('/scheme', 'SECURITY_POLICY_BLOCKED'), ('/large', 'DOWNLOAD_TOO_LARGE'), ('/encoded', 'PROVIDER_ERROR')]:
        with pytest.raises(BrowseFnError) as error:
            await fetch_public_page(base + path, options)
        assert error.value.code == code
    assert calls.count('/loop') == 6
    with pytest.raises(BrowseFnError) as error:
        await fetch_public_page(base + '/slow', GetPageOptions(security={'allowPrivateHosts': True}, timeout=20))
    assert error.value.code == 'UPSTREAM_TIMEOUT'


@pytest.mark.asyncio
async def test_denial_is_terminal_before_fallback_or_retry(owned):
    base, calls = owned
    web = service()
    class Custom:
        capabilities = BeautifulSoupProvider.capabilities
        async def is_available(self): return True
        async def get_page(self, *_args): raise AssertionError('custom provider invoked')
    web.register_provider('custom', Custom())
    with pytest.raises(BrowseFnError) as error:
        await web.get_page(base, GetPageOptions(security={}, retry={'count': 2, 'delay': 0}))
    assert error.value.code == 'SECURITY_POLICY_BLOCKED'
    assert calls == []


@pytest.mark.asyncio
async def test_mixed_dns_answers_are_denied_before_connect(owned, monkeypatch):
    base, calls = owned
    loop = asyncio.get_running_loop()
    async def resolve(*_args, **_kwargs):
        return [(2, 1, 6, '', ('93.184.216.34', 80)), (2, 1, 6, '', ('127.0.0.1', 80))]
    monkeypatch.setattr(loop, 'getaddrinfo', resolve)
    with pytest.raises(BrowseFnError) as error:
        await fetch_public_page(base.replace('127.0.0.1', 'mixed.test'), GetPageOptions(security={}))
    assert error.value.code == 'SECURITY_POLICY_BLOCKED'
    assert calls == []


@pytest.mark.asyncio
async def test_redirect_private_target_receives_no_request(owned, monkeypatch):
    # Only the owned origin is classified public in this fixture; target uses normal policy.
    from browsefn.web import public_page
    base, calls = owned
    original = public_page.is_public_address
    monkeypatch.setattr(public_page, 'is_public_address', lambda address: address == '127.0.0.1' or original(address))
    with pytest.raises(BrowseFnError) as error:
        await fetch_public_page(base + '/private-redirect', GetPageOptions(security={}))
    assert error.value.code == 'SECURITY_POLICY_BLOCKED'
    assert calls == ['/private-redirect']


@pytest.mark.asyncio
async def test_checked_dns_answer_is_pinned_without_hostname_reresolution(owned, monkeypatch):
    base, calls = owned
    loop = asyncio.get_running_loop()
    original = loop.getaddrinfo
    resolutions = []
    async def resolve(host, port, **kwargs):
        if host in {'pinned.test', b'pinned.test'}:
            resolutions.append(host)
            assert len(resolutions) == 1, 'hostname was resolved again after validation'
            return await original('127.0.0.1', port, **kwargs)
        return await original(host, port, **kwargs)
    monkeypatch.setattr(loop, 'getaddrinfo', resolve)
    html, _url = await fetch_public_page(base.replace('127.0.0.1', 'pinned.test'), GetPageOptions(security={'allowPrivateHosts': True}))
    assert 'Owned fixture' in html
    assert len(resolutions) == 1
    assert calls == ['/']


@pytest.mark.asyncio
async def test_router_image_private_host_override_is_ignored(owned, tmp_path):
    from browsefn.images.browser import ImageBrowser
    base, calls = owned
    routes = create_browsefn_router(SimpleNamespace(images=ImageBrowser()))
    response = await _route(routes, '/images/download').handler(MockRequest(json_body={'url': base, 'options': {'allowPrivateHosts': True, 'destination': str(tmp_path)}}), None)
    assert response.status == 403
    assert calls == []
    assert list(tmp_path.iterdir()) == []
