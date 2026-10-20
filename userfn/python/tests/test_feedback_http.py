import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from userfn import UserFnClient, UserFnOptions, FeedbackSubmission, FeedbackDeliveryError, FeedbackHTTPError


@pytest.fixture
def endpoint():
    calls = []
    replies = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            calls.append((self.path, {key.lower(): value for key, value in self.headers.items()}, self.rfile.read(int(self.headers['Content-Length']))))
            status, body, extra, delay = replies.pop(0) if replies else (201, {'id': 'stored', 'accepted': True}, {}, 0)
            time.sleep(delay)
            self.send_response(status)
            for name, value in extra.items():
                self.send_header(name, value)
            self.end_headers()
            try:
                self.wfile.write(body.encode() if isinstance(body, str) else json.dumps(body).encode())
            except BrokenPipeError:
                pass
        def log_message(self, *_args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/api', calls, replies
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def submission():
    return FeedbackSubmission(title='Bug 文', body='Details', category='bug')


def test_real_http_retries_stable_body_and_key(endpoint):
    url, calls, replies = endpoint
    replies.append((503, {'error': 'unavailable'}, {}, 0))
    client = UserFnClient(UserFnOptions(api_key='secret', endpoint=url, feedback_max_attempts=2))
    client.identify('user', {'plan': 'pro'})
    asyncio.run(client.submit_feedback(submission()))
    assert len(calls) == 2
    assert calls[0][0] == '/api/feedback'
    assert calls[0][1]['authorization'] == 'Bearer secret'
    assert calls[0][1]['idempotency-key'] == calls[1][1]['idempotency-key']
    assert calls[0][2] == calls[1][2]
    assert json.loads(calls[0][2])['context']['user']['id'] == 'user'


@pytest.mark.parametrize('status,body', [(401, 'private secret'), (409, 'conflict'), (200, 'not JSON'), (200, {'accepted': False}), (200, 'x' * 65537)])
def test_terminal_responses_never_acknowledged_or_retried(endpoint, status, body):
    url, calls, replies = endpoint
    replies.append((status, body, {}, 0))
    client = UserFnClient(UserFnOptions(api_key='key', endpoint=url))
    with pytest.raises(FeedbackDeliveryError) as caught:
        asyncio.run(client.submit_feedback(submission(), idempotency_key='manual-key'))
    assert len(calls) == 1
    assert calls[0][1]['idempotency-key'] == 'manual-key'
    assert 'private secret' not in str(caught.value)
    if status >= 400:
        assert isinstance(caught.value, FeedbackHTTPError)
        assert caught.value.status == status


def test_redirects_are_not_followed(endpoint):
    url, calls, replies = endpoint
    replies.append((307, '', {'Location': url + '/other'}, 0))
    client = UserFnClient(UserFnOptions(api_key='secret', endpoint=url))
    with pytest.raises(FeedbackHTTPError) as caught:
        asyncio.run(client.submit_feedback(submission()))
    assert caught.value.status == 307
    assert len(calls) == 1


def test_timeout_does_not_acknowledge(endpoint):
    url, calls, replies = endpoint
    replies.append((201, {'id': 'late', 'accepted': True}, {}, 0.1))
    client = UserFnClient(UserFnOptions(api_key='key', endpoint=url, feedback_timeout_ms=10, feedback_max_attempts=1))
    with pytest.raises((TimeoutError, OSError)):
        asyncio.run(client.submit_feedback(submission()))
    assert len(calls) == 1
