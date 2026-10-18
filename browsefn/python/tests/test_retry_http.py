import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from browsefn import browse_fn, BrowseFnConfig
from browsefn.core.errors import BrowseFnError


@pytest.mark.asyncio
async def test_real_http_status_retry_overrides_and_callback():
    state = {'calls': 0, 'status': 503, 'failures': 1}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_GET(self):
            state['calls'] += 1
            self.send_response(state['status'] if state['calls'] <= state['failures'] else 200)
            self.end_headers()
            self.wfile.write(b'<title>done</title>')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    callbacks = []
    retry = {'enabled': True, 'maxAttempts': 5, 'delay': 0, 'backoff': 'linear', 'retryOn': [503], 'onRetry': lambda attempt, error: callbacks.append(attempt)}
    browser = browse_fn(BrowseFnConfig(retry=retry))
    url = f'http://127.0.0.1:{server.server_port}'
    try:
        assert (await browser.web.get_page(url)).metadata.title == 'done'
        assert state['calls'] == 2 and callbacks == [1]
        state.update(calls=0, status=404)
        with pytest.raises(BrowseFnError) as error:
            await browser.web.get_page(url)
        assert error.value.code == 'UPSTREAM_NOT_FOUND' and state['calls'] == 1
        state.update(calls=0, status=503, failures=100)
        for count in [0, 1]:
            state['calls'] = 0
            with pytest.raises(BrowseFnError) as error:
                await browser.web.get_page(url, {'retry': {'count': count, 'delay': 0}})
            assert error.value.details['statusCode'] == 503
            assert state['calls'] == count + 1
        state.update(calls=0, failures=1)
        assert (await browse_fn().web.get_page(url, {'retry': {'count': 1, 'delay': 0}})).metadata.title == 'done'
        assert state['calls'] == 2
    finally:
        server.shutdown(); server.server_close(); thread.join()
