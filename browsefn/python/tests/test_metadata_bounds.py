"""Metadata admission bounds and stable work snapshots."""
import asyncio
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from superfunctions.http import RouteContext
from browsefn import BrowseFn
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import MetadataOptions, PageMetadata, PageResult, ProviderCapabilities
from browsefn.web.scraper import WebScraper
from browsefn.http.router import create_browsefn_router


def urls(count):
    return [f'https://example.test/{index}' for index in range(count)]


class Provider:
    name = 'owned'
    capabilities = ProviderCapabilities(formats=['html'], javascript=False, screenshots=False, cookies=False, headers=False, selectors=False)
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.gate = None
    async def is_available(self):
        return True
    async def get_page(self, url, options):
        self.calls.append(url)
        self.started.set()
        if self.gate is not None:
            await self.gate.wait()
        return PageResult(url=url, content='', provider='owned', metadata=PageMetadata(url=url, title=url))


def fixture():
    scraper, provider = WebScraper(), Provider()
    scraper.register_provider('owned', provider)
    return scraper, provider


@pytest.mark.asyncio
async def test_exact_limit_and_override_cannot_raise_ceiling():
    scraper, provider = fixture()
    assert len(await scraper.get_multiple_metadata(urls(100))) == 100
    provider.calls.clear()
    with pytest.raises(BrowseFnError):
        await scraper.get_multiple_metadata(urls(101))
    with pytest.raises(ValidationError):
        MetadataOptions(maxBatchOverride=1000)
    assert not provider.calls
    with pytest.raises(BrowseFnError):
        await scraper.get_multiple_metadata(urls(3), MetadataOptions(maxBatchOverride=2))


@pytest.mark.asyncio
async def test_snapshot_before_first_provider_and_progress_mutation():
    scraper, provider = fixture()
    provider.gate = asyncio.Event()
    input_urls, progress = urls(2), []
    def report(done, total):
        progress.append((done,total))
        input_urls.append('https://example.test/late')
    options = MetadataOptions(concurrency=1, fields=['title'], onProgress=report)
    work = asyncio.create_task(scraper.get_multiple_metadata(input_urls, options))
    await provider.started.wait()
    input_urls.extend(urls(100))
    options.fields[:] = ['description']
    provider.gate.set()
    result = await work
    assert len(result) == 2 and len(provider.calls) == 2
    assert result[0].data.title == 'https://example.test/0'
    assert progress == [(1,2),(2,2)]


@pytest.mark.parametrize('value', [0,-1,1.5,float('nan'),float('inf'),101,'2',True])
def test_strict_bounded_options(value):
    for key in ('concurrency','maxBatchOverride'):
        with pytest.raises(ValidationError):
            MetadataOptions(**{key:value})


@pytest.mark.asyncio
async def test_invalid_collections_before_provider():
    scraper, provider = fixture()
    for value in (None, {}, [1], ['https://example.test', None]):
        with pytest.raises(BrowseFnError):
            await scraper.get_multiple_metadata(value)
    assert not provider.calls


@pytest.mark.asyncio
async def test_actual_router_boundary():
    router = create_browsefn_router(BrowseFn())
    route = next(route for route in router if route.path == '/web/metadata')
    for count in (100,101):
        async def body():
            return {'urls':['http://127.0.0.1/never-request']*count,'options':{'maxBatchOverride':1000} if count==101 else {}}
        request = SimpleNamespace(json=body,headers={},method='POST',path='/web/metadata')
        response = await route.handler(request, RouteContext(url='/web/metadata',method='POST'))
        assert response.status == (200 if count==100 else 400)
        if count==100:
            assert len(response.body['data']['results']) == 100
        else:
            assert response.body['error']['code'] == 'INVALID_ARGUMENT'

@pytest.mark.asyncio
async def test_actual_image_batch_50_and_snapshot(tmp_path):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    from io import BytesIO
    from PIL import Image
    from browsefn.images.browser import ImageBrowser
    from browsefn.core.types import ImageDownloadOptions
    image = BytesIO()
    Image.new('RGB',(1,1),'red').save(image, format='PNG')
    hits = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'<title>Owned</title>' if self.path.startswith('/page') else image.getvalue())
        def log_message(self, *_args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        base = f'http://127.0.0.1:{server.server_port}'
        inputs = [f'{base}/{index}.png' for index in range(50)]
        progress = []
        def report(done,total):
            progress.append((done,total))
            if done == 1:
                inputs.append(f'{base}/late.png')
                options.destination = '/must-not-write'
        options = ImageDownloadOptions(allowPrivateHosts=True,destination=str(tmp_path),concurrency=1,onProgress=report)
        results = await ImageBrowser().download_batch(inputs,options)
        assert len(results)==50 and all(result.success for result in results)
        assert len(hits)==50 and len(list(tmp_path.iterdir()))==50
        assert progress[-1]==(50,50)
        with pytest.raises(BrowseFnError):
            await ImageBrowser().download_batch(inputs,options)
        assert len(hits)==50
        from browsefn.web.providers.bs4 import BeautifulSoupProvider
        from browsefn.core.types import DestinationSecurity
        scraper = WebScraper()
        scraper.register_provider('cheerio',BeautifulSoupProvider())
        metadata = await scraper.get_multiple_metadata([f'{base}/page/{index}' for index in range(100)],MetadataOptions(security=DestinationSecurity(allowPrivateHosts=True)))
        assert len(metadata)==100 and all(item.success and item.data.title=='Owned' for item in metadata)
        assert len(hits)==150
        for value in (0,-1,1.5,51,True,'2'):
            with pytest.raises(ValidationError):
                ImageDownloadOptions(concurrency=value)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()
