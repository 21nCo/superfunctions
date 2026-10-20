"""HTTP client for the UserFn feedback service; no ambient cookies or redirects."""
import asyncio
import json
import time
import uuid
from dataclasses import asdict
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
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

    def _send(self, body: bytes, key: str) -> FeedbackReceipt:
        opener = build_opener(_NoRedirect(), ProxyHandler({}))
        for attempt in range(self.attempts):
            try:
                request = Request(self.url, data=body, method='POST', headers={
                    'Authorization': f'Bearer {self.key}', 'Content-Type': 'application/json', 'Idempotency-Key': key,
                })
                with opener.open(request, timeout=self.timeout / 1000) as response:
                    raw = response.read(65537)
                    if len(raw) > 65536:
                        raise FeedbackDeliveryError('Feedback service returned an oversized receipt')
                    try:
                        value = json.loads(raw)
                    except (ValueError, UnicodeError) as error:
                        raise FeedbackDeliveryError('Feedback service returned an invalid receipt') from error
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
