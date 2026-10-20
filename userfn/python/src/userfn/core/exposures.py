"""Bounded Watch HTTP exposure queue. Explicit async flush preserves sync evaluation."""
import asyncio
import json
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit


class FlagExposures:
    def __init__(self, options, environment=None):
        try:
            import httpx
        except ImportError as exc:
            raise ImportError('Install userfn[exposures] for Watch exposure delivery') from exc
        url = urlsplit(options.endpoint)
        if (url.scheme != 'https' and not (options.allow_insecure_http is True and url.scheme == 'http')) or not url.netloc or url.username or url.password or url.fragment:
            raise ValueError('Invalid exposure endpoint')
        if not isinstance(options.app, str) or not options.app.strip() or len(options.app) > 200 or not isinstance(options.api_key, str) or not options.api_key.strip() or '\r' in options.api_key or '\n' in options.api_key:
            raise ValueError('Exposure app and API key are required')
        for value, low, high in [(options.max_queue_size, 1, 100000), (options.timeout_ms, 1, 300000)]:
            if type(value) is not int or not low <= value <= high:
                raise ValueError('Invalid exposure limit')
        self.httpx = httpx
        self.endpoint, self.key, self.app = options.endpoint, options.api_key, options.app
        self.limit, self.timeout = options.max_queue_size, options.timeout_ms / 1000
        self.environment = environment
        self.queue = []
        self.pending = None
        self.closed = False
        self.dropped = 0
        self.unreported_drops = 0
        self.last_error = None

    def capture(self, key, result, user):
        try:
            if self.closed or len(self.queue) >= self.limit:
                raise ValueError()
            event = {'id': str(uuid.uuid4()), 'type': 'track', 'name': 'userfn.flag_exposure',
                     'timestamp': datetime.now(timezone.utc).isoformat(), 'app': {'name': self.app},
                     'properties': {'flagKey': key, 'variationId': result['variationId'],
                                    'ruleId': result['ruleId'], 'reason': result['reason']}}
            if user is not None:
                event['user'] = {'id': user.id}
            if self.environment is not None:
                event['properties']['environment'] = self.environment
            encoded = json.dumps(event, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode()
            if len(encoded) > 64 * 1024:
                raise ValueError()
            self.queue.append(encoded)
        except Exception:
            self.dropped += 1
            self.unreported_drops += 1
            self.last_error = 'Exposure rejected: queue closed, full or event too large'

    async def _drain(self):
        try:
            async with self.httpx.AsyncClient(timeout=self.timeout, follow_redirects=False, trust_env=False) as client:
                while self.queue:
                    batch, size = [], 2
                    for event in self.queue[:100]:
                        if size + len(event) + 1 > 1024 * 1024:
                            break
                        batch.append(event)
                        size += len(event) + 1
                    body = b'[' + b','.join(batch) + b']'
                    async def send():
                        async with client.stream('POST', self.endpoint, content=body, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.key}) as response:
                            if not 200 <= response.status_code < 300:
                                raise ValueError('Exposure request rejected')
                    await asyncio.wait_for(send(), timeout=self.timeout)
                    del self.queue[:len(batch)]
            self.last_error = None
        except asyncio.CancelledError:
            self.last_error = 'Exposure delivery cancelled; queued events retained'
            raise
        except Exception:
            self.last_error = 'Exposure delivery failed; queued events retained'
            raise RuntimeError(self.last_error) from None

    async def flush(self):
        if self.pending is None:
            self.pending = asyncio.create_task(self._drain())
            self.pending.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        task = self.pending
        try:
            await asyncio.shield(task)
            if self.unreported_drops:
                self.unreported_drops = 0
                self.last_error = "Exposure events were rejected before delivery"
                raise RuntimeError(self.last_error)
        finally:
            if task.done() and self.pending is task:
                self.pending = None

    async def close(self):
        self.closed = True
        await self.flush()

    def status(self):
        return {'pending': len(self.queue), 'dropped': self.dropped, 'lastError': self.last_error, 'closed': self.closed}
