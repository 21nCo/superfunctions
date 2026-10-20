"""HTTP client for the UserFn feedback service; no ambient cookies or redirects."""
import asyncio
import json
import re
import time
import uuid
from dataclasses import asdict
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from ..types import FeedbackSubmission, FeedbackContext, FeedbackReceipt, UserFnOptions
from .feedback import FeedbackDeliveryError


class FeedbackHTTPError(FeedbackDeliveryError):
    def __init__(self, status: int):
        self.status = status
        super().__init__(f'Feedback request failed with HTTP {status}')


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HttpFeedbackService:
    def __init__(self, options: UserFnOptions):
        endpoint = urlsplit(options.endpoint or '')
        if (endpoint.scheme not in ('http', 'https') or not endpoint.hostname
                or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment):
            raise ValueError('Invalid UserFn endpoint')
        if not options.api_key.strip():
            raise ValueError('UserFn api_key is required')
        self.url = (options.endpoint or '').rstrip('/') + '/feedback'
        self.key = options.api_key
        self.attempts = options.feedback_max_attempts
        self.timeout = options.feedback_timeout_ms
        if (type(self.attempts) is not int or not 1 <= self.attempts <= 5
                or type(self.timeout) is not int or not 1 <= self.timeout <= 60000):
            raise ValueError('Invalid feedback retry/timeout configuration')

    async def submit(self, feedback: FeedbackSubmission, context: FeedbackContext) -> FeedbackReceipt:
        # Serialize before entering a worker, keeping payload and idempotency stable for all attempts.
        submission = {key: value for key, value in asdict(feedback).items() if value is not None}
        body = json.dumps({'feedback': submission, 'context': {
            'source': context.source, 'user': asdict(context.user) if context.user else None,
        }}, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(body) > 65536:
            raise ValueError('Feedback request exceeds 65536 bytes')
        return await asyncio.to_thread(self._send, body, context.idempotency_key or str(uuid.uuid4()))

    async def list(self, options=None):
        return await asyncio.to_thread(self._send, None, None, '?' + urlencode(options or {}), 'GET', 'board')

    async def vote(self, feedback_id: str, direction: int):
        self._validate_id(feedback_id)
        if type(direction) is not int or direction not in (-1, 0, 1):
            raise ValueError('Invalid vote direction')
        return await asyncio.to_thread(self._send, json.dumps({'direction': direction}).encode(), None, '/' + feedback_id + '/vote', 'POST', 'vote', feedback_id)

    async def set_status(self, feedback_id: str, status: str):
        self._validate_id(feedback_id)
        if status not in ('open', 'planned', 'in_progress', 'done', 'closed'):
            raise ValueError('Invalid feedback status')
        result = await asyncio.to_thread(self._send, json.dumps({'status': status}).encode(), None, '/' + feedback_id + '/status', 'PATCH', 'status', feedback_id)
        if result.get('status') != status:
            raise FeedbackDeliveryError('Invalid feedback status response')
        return result

    @staticmethod
    def _validate_id(feedback_id):
        if not isinstance(feedback_id, str) or not re.fullmatch(r'uf_[a-f0-9]{64}', feedback_id):
            raise ValueError('Invalid feedback ID')

    def _send(self, body, key, path='', method='POST', kind='receipt', feedback_id=None):
        opener = build_opener(_NoRedirect(), ProxyHandler({}))
        for attempt in range(self.attempts):
            try:
                request = Request(self.url + path, data=body, method=method, headers={
                    'Authorization': f'Bearer {self.key}', 'Content-Type': 'application/json', **({'Idempotency-Key': key} if key else {}),
                })
                with opener.open(request, timeout=self.timeout / 1000) as response:
                    maximum = 16 * 1024 * 1024 if kind == 'board' else 65536
                    raw = response.read(maximum + 1)
                    if len(raw) > maximum:
                        raise FeedbackDeliveryError('Feedback service returned an oversized receipt')
                    try:
                        value = json.loads(raw)
                    except (ValueError, UnicodeError) as error:
                        raise FeedbackDeliveryError('Feedback service returned an invalid receipt') from error
                    if kind != 'receipt':
                        if not isinstance(value, dict):
                            raise FeedbackDeliveryError('Invalid feedback response')
                        if kind == 'board':
                            if (not isinstance(value.get('items'), list)
                                    or not ('nextCursor' in value and (value['nextCursor'] is None or (isinstance(value['nextCursor'], str) and re.fullmatch(r'uf_[a-f0-9]{64}', value['nextCursor']))))
                                    or len(value['items']) > 100
                                    or any(not isinstance(item, dict) or not isinstance(item.get('id'), str) or not re.fullmatch(r'uf_[a-f0-9]{64}', item['id']) or not isinstance(item.get('title'), str) or not isinstance(item.get('body'), str) or type(item.get('votes')) is not int or type(item.get('viewerVote')) is not int or item['viewerVote'] not in (-1, 0, 1) or item.get('status') not in ('open', 'planned', 'in_progress', 'done', 'closed') or not isinstance(item.get('createdAt'), str) for item in value['items'])):
                                raise FeedbackDeliveryError('Invalid feedback board response')
                        elif value.get('id') != feedback_id:
                            raise FeedbackDeliveryError('Invalid feedback response ID')
                        if kind == 'vote' and (type(value.get('votes')) is not int or type(value.get('viewerVote')) is not int or value['viewerVote'] not in (-1, 0, 1)):
                            raise FeedbackDeliveryError('Invalid feedback vote response')
                        return value
                    if (not isinstance(value, dict) or value.get('accepted') is not True
                            or not isinstance(value.get('id'), str) or not value['id'].strip()):
                        raise FeedbackDeliveryError('Feedback service did not acknowledge acceptance')
                    return FeedbackReceipt(id=value['id'], accepted=True)
            except HTTPError as error:
                status = error.code
                error.close()
                if attempt + 1 == self.attempts or not (status in (408, 429) or status >= 500):
                    raise FeedbackHTTPError(status) from error
            except (URLError, TimeoutError, OSError):
                if attempt + 1 == self.attempts:
                    raise
            time.sleep(0.1 * 2 ** attempt)
        raise FeedbackDeliveryError('Feedback delivery exhausted')
