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
            calls.append((self.path, {key.lower(): value for key, value in self.headers.items()}, self.rfile.read(int(self.headers.get('Content-Length', '0')))))
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
        do_GET = do_POST
        do_PATCH = do_POST
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


@pytest.mark.parametrize('kind,reply', [
    ('board', {'items': [], 'nextCursor': 42}),
    ('vote', {'id': 'uf_' + 'a' * 64, 'votes': True, 'viewerVote': 1}),
    ('status', {'id': 'uf_' + 'a' * 64, 'status': 'closed'}),
])
def test_malformed_board_operations_never_acknowledged(endpoint, kind, reply):
    url, calls, replies = endpoint
    replies.append((200, reply, {}, 0))
    client = UserFnClient(UserFnOptions(api_key='key', endpoint=url))
    feedback_id = 'uf_' + 'a' * 64
    operation = (client.get_feedback_board() if kind == 'board' else
                 client.vote_feedback(feedback_id, 1) if kind == 'vote' else
                 client.set_feedback_status(feedback_id, 'planned'))
    with pytest.raises(FeedbackDeliveryError):
        asyncio.run(operation)
    assert len(calls) == 1


def test_vote_retry_preserves_target_and_direction(endpoint):
    url, calls, replies = endpoint
    feedback_id = 'uf_' + 'b' * 64
    replies.extend([(503, {}, {}, 0), (200, {'id': feedback_id, 'votes': -1, 'viewerVote': -1}, {}, 0)])
    client = UserFnClient(UserFnOptions(api_key='key', endpoint=url, feedback_max_attempts=2))
    assert asyncio.run(client.vote_feedback(feedback_id, -1))['viewerVote'] == -1
    assert len(calls) == 2
    assert calls[0][0] == calls[1][0]
    assert calls[0][2] == calls[1][2] == b'{"direction": -1}'


def test_metadata_patch_retries_and_validates_acknowledgment(endpoint):
    url, calls, replies = endpoint
    feedback_id = 'uf_' + 'c' * 64
    patch = {'tags': [' UI ', 'UI'], 'productArea': None}
    reply = {'id': feedback_id, 'tags': ['UI'], 'productArea': None}
    replies.extend([(503, {}, {}, 0), (200, reply, {}, 0)])
    client = UserFnClient(UserFnOptions(api_key='key', endpoint=url, feedback_max_attempts=2))
    assert asyncio.run(client.set_feedback_metadata(feedback_id, patch)) == reply
    assert calls[0][0] == calls[1][0] == '/api/feedback/' + feedback_id + '/metadata'
    assert calls[0][2] == calls[1][2]
    for invalid in [{}, {**reply, 'tags': None}, {**reply, 'tags': ['different']}, {**reply, 'productArea': 'different'}, {**reply, 'id': 'wrong'}]:
        before = len(calls)
        replies.append((200, invalid, {}, 0))
        with pytest.raises(FeedbackDeliveryError):
            asyncio.run(client.set_feedback_metadata(feedback_id, patch))
        assert len(calls) == before + 1
    before = len(calls)
    for invalid in [{}, {'tags': None}, {'tags': [42]}, {'tags': [' ']}, {'tags': [], 'actorId': 'spoof'}]:
        with pytest.raises(ValueError):
            asyncio.run(client.set_feedback_metadata(feedback_id, invalid))
    assert len(calls) == before
    with pytest.raises(FeedbackDeliveryError, match='not configured'):
        asyncio.run(UserFnClient(UserFnOptions(api_key='key')).set_feedback_metadata(feedback_id, patch))
