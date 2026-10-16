from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import json

import pytest

from browsefn.core.types import GetPageOptions
from browsefn.web.providers.bs4 import BeautifulSoupProvider


@pytest.mark.asyncio
async def test_relative_resources_use_final_redirect_url():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/old':
                self.send_response(302)
                self.send_header('Location', '/new/directory/page')
                self.end_headers()
            else:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'<html><head><title>Redirected</title></head><body><a href="child">Child</a><img src="image.png"></body></html>')

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = f'http://127.0.0.1:{server.server_port}'
    try:
        page = await BeautifulSoupProvider().get_page(base + '/old', GetPageOptions(includeLinks=True, includeImages=True, format='json'))
        assert page.url == base + '/new/directory/page'
        assert page.metadata.url == page.url
        assert base + '/new/directory/child' in page.links
        assert base + '/new/directory/image.png' in page.images
        assert json.loads(page.content)['links'] == page.links
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
