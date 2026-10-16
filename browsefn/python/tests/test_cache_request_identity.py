import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from browsefn import browse_fn, BrowseFnConfig


@pytest.mark.asyncio
async def test_cache_isolates_credentials_selectors_and_honors_per_request_ttl(tmp_path):
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_GET(self):
            identity = self.headers.get('Authorization', 'anonymous')
            calls.append(identity)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(f'<html><body><p>{identity}</p><div>extra</div></body></html>'.encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        browser = browse_fn(BrowseFnConfig(cache={'enabled': True, 'storage': 'file', 'directory': str(tmp_path)}))
        url = f'http://127.0.0.1:{server.server_port}'
        async def fetch(identity, **options):
            return await browser.web.get_page(url, {'format': 'text', 'headers': {'Authorization': identity}, 'cache': {'ttl': 1000}, **options})
        alice = await fetch('Alice-secret')
        bob = await fetch('Bob-secret')
        assert 'Alice-secret' in alice.content and 'Bob-secret' in bob.content
        await fetch('Alice-secret')
        assert calls == ['Alice-secret', 'Bob-secret']
        selected = await fetch('Alice-secret', selectors={'include': ['p']})
        assert 'extra' not in selected.content
        await fetch('short-lived', cache={'ttl': 1})
        await asyncio.sleep(.02)
        await fetch('short-lived', cache={'ttl': 1})
        assert calls.count('short-lived') == 2
        # Cache key fingerprints do not persist raw header credentials in keys.
        assert all('Alice-secret' not in key and 'Bob-secret' not in key for key in await browser.cache_manager._run(lambda entries: list(entries)))
    finally:
        server.shutdown(); server.server_close(); thread.join()
