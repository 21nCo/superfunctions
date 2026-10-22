"""Durable admission journal. Host owns the private state path and verified session."""
import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.parse import urlsplit
import re

class MessagingDeliveryError(RuntimeError):
    pass

class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class HttpMessaging:
    def __init__(self, options):
        self.path = Path(options.messaging_state_path)
        endpoint = urlsplit(options.endpoint or '')
        if endpoint.scheme not in ('http', 'https') or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or not options.api_key.strip():
            raise ValueError('Invalid messaging endpoint/credential')
        self.url = options.endpoint.rstrip('/')
        self.token = options.api_key
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    @contextmanager
    def exclusive(self):
        import fcntl
        fd = os.open(str(self.path) + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def read(self):
        if not self.path.exists():
            return {}
        if self.path.stat().st_size > 65536:
            raise MessagingDeliveryError('Messaging journal exceeds bounds')
        value = json.loads(self.path.read_text())
        if not isinstance(value, dict) or len(value) > 100:
            raise MessagingDeliveryError('Invalid messaging journal')
        for key, entry in value.items():
            if (not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', key) or not isinstance(entry, dict)
                or not isinstance(entry.get('key'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', entry['key'])
                or entry.get('phase') not in ('pending', 'presenting', 'shown') or not isinstance(entry.get('user'), str) or len(entry['user']) > 200):
                raise MessagingDeliveryError('Invalid messaging journal')
        return value

    def save(self, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        if len(value) > 100 or len(data) > 65536:
            raise MessagingDeliveryError('Messaging journal full')
        fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name + '.')
        try:
            with os.fdopen(fd, 'wb') as target:
                target.write(data); target.flush(); os.fsync(target.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)

    def send(self, campaign_id, key, action):
        request = Request(f'{self.url}/messages/{campaign_id}/{action}', data=b'{}', method='POST', headers={
            'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json', 'Idempotency-Key': key})
        try:
            with build_opener(_NoRedirect(), ProxyHandler({})).open(request, timeout=10) as response:
                data = response.read(8193)
                if len(data) > 8192: raise MessagingDeliveryError('Oversized messaging receipt')
                value = json.loads(data)
        except Exception as error:
            raise MessagingDeliveryError('Message request did not acknowledge admission') from error
        if not isinstance(value, dict) or value.get('campaignId') != campaign_id or type(value.get('allowed')) is not bool or type(value.get('shown')) is not bool:
            raise MessagingDeliveryError('Invalid messaging receipt')
        return value

    def admit(self, campaign_id, user, allowed):
        """Return admitted, denied, or handled; only explicit denial permits another candidate."""
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', campaign_id) or not user or len(user) > 200:
            raise MessagingDeliveryError('Invalid campaign identity')
        journal = self.read()
        entry = journal.get(campaign_id)
        if entry and entry['user'] != user:
            raise MessagingDeliveryError('Messaging journal belongs to another user; use a distinct state path')
        if entry and entry['phase'] == 'presenting': return 'handled'
        if entry and entry['phase'] == 'shown':
            self.send(campaign_id, entry['key'], 'shown')
            del journal[campaign_id]; self.save(journal); return 'handled'
        entry = entry or {'key': str(uuid.uuid4()), 'phase': 'pending', 'user': user}
        journal[campaign_id] = entry; self.save(journal)
        receipt = self.send(campaign_id, entry['key'], 'reserve')
        if not receipt['allowed'] or receipt['shown']:
            del journal[campaign_id]; self.save(journal); return 'handled' if receipt['allowed'] else 'denied'
        if not allowed(): return 'handled'
        entry['phase'] = 'presenting'; self.save(journal)
        # File persistence can release the GIL; identity/consent may change while saving.
        return 'admitted' if allowed() else 'handled'

    def confirm(self, campaign_id):
        with self.exclusive():
            journal = self.read(); entry = journal.get(campaign_id)
            if not entry or entry['phase'] == 'pending': raise MessagingDeliveryError('No presented reservation')
            entry['phase'] = 'shown'; self.save(journal)
            self.send(campaign_id, entry['key'], 'shown')
            del journal[campaign_id]; self.save(journal)

    def status(self):
        with self.exclusive():
            return {key: 'uncertain' if entry['phase'] == 'presenting' else entry['phase'] for key, entry in self.read().items()}
