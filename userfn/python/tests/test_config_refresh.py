import asyncio
import base64
import copy
import hashlib
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
pytest.importorskip('httpx')
pytest.importorskip('cryptography')
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from userfn import UserFnClient, UserFnOptions, SignedConfigOptions, ConfigRefreshError
from userfn.types import FlagConfig


@pytest.fixture
def endpoint():
    key = Ed25519PrivateKey.generate()
    snapshot = dict(version=1, algorithm='Ed25519', keyId='key-1', tenantId='a', environment='production', revision=str(uuid.uuid4()),
                    flags=[dict(key='enabled', enabled=True, defaultValue='remote', variations=[], rules=[])], segments=[])
    state = dict(mode='normal', snapshot=snapshot, headers=[])
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            state['headers'].append(dict(self.headers))
            value = copy.deepcopy(state['snapshot'])
            mode = state['mode']
            if isinstance(mode, dict):
                value.update(mode)
            raw = json.dumps(value, separators=(',', ':')).encode()
            etag = '"' + hashlib.sha256(raw).hexdigest() + '"'
            signature = base64.urlsafe_b64encode(key.sign(raw)).decode().rstrip('=')
            status = 304 if mode == '304' or (mode == 'normal' and self.headers.get('If-None-Match') == etag) else 200
            if mode == 'signature':
                signature = 'A' * 86
            if mode == 'etag':
                etag = '"wrong"'
            if mode == 'oversize':
                raw = b'x' * 270337
            self.send_response(status)
            self.send_header('ETag', etag)
            self.send_header('X-UserFn-Signature', signature)
            self.send_header('Content-Length', str(len(raw) if status == 200 else 0))
            self.end_headers()
            try:
                if mode == 'slow':
                    self.wfile.write(raw[:1]); self.wfile.flush(); time.sleep(.2); self.wfile.write(raw[1:])
                elif status == 200:
                    self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    def client(timeout=1000):
        encoded = base64.urlsafe_b64encode(key.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).decode().rstrip('=')
        return UserFnClient(UserFnOptions(api_key='key', endpoint='http://127.0.0.1:' + str(server.server_port), environment='production', bootstrap_flags={'enabled': 'bootstrap'}, config=SignedConfigOptions(tenant_id='a', trusted_keys={'key-1': encoded}, allow_insecure_http=True, timeout_ms=timeout)))
    yield state, client
    server.shutdown(); server.server_close(); thread.join()


def test_verified_refresh_coalescing_cache_and_manual_invalidation(endpoint):
    state, create = endpoint
    async def run():
        client = create()
        assert await asyncio.gather(client.refresh_config(), client.refresh_config()) == [True, True]
        assert len(state['headers']) == 1 and client.get_flag('enabled') == 'remote'
        assert await client.refresh_config() is False
        client.set_flags([FlagConfig(key='enabled', enabled=True, default_value='manual', variations=[], rules=[])])
        state['mode'] = '304'
        with pytest.raises(ConfigRefreshError):
            await client.refresh_config()
        assert client.get_flag('enabled') == 'manual'
        assert 'If-None-Match' not in state['headers'][-1]
        state['mode'] = 'normal'; assert await client.refresh_config() is True
        client.set_segments([]); assert await client.refresh_config() is True
        client.close_config()
        with pytest.raises(ConfigRefreshError):
            await client.refresh_config()
    asyncio.run(run())


def test_unverified_or_invalid_snapshots_preserve_bootstrap_and_last_good(endpoint):
    state, create = endpoint
    async def run():
        client = create(); state['mode'] = '304'
        with pytest.raises(ConfigRefreshError):
            await client.refresh_config()
        assert client.get_flag('enabled') == 'bootstrap'
        state['mode'] = 'normal'; assert await client.refresh_config()
        for mode in ['signature', 'etag', 'oversize', {'version': True}, {'version': 2}, {'tenantId': 'b'}, {'environment': 'staging'}, {'keyId': 'unknown'}, {'algorithm': 'none'},
                     {'flags': [{**state['snapshot']['flags'][0], 'defaultVariationId': 'missing'}], 'segments': []},
                     {'segments': [{'id': 'x', 'name': 'x', 'rules': [{'id': 'r', 'field': 'x', 'operator': 'unknown'}]}]}]:
            state['mode'] = mode
            with pytest.raises(ConfigRefreshError):
                await client.refresh_config()
            assert client.get_flag('enabled') == 'remote'
        state['mode'] = 'normal'; assert await client.refresh_config() is False
    asyncio.run(run())


def test_total_deadline_and_close_prevent_late_application(endpoint):
    state, create = endpoint
    async def run():
        state['mode'] = 'slow'; client = create(30)
        started = time.monotonic()
        with pytest.raises(ConfigRefreshError):
            await client.refresh_config()
        assert time.monotonic() - started < .15
        await asyncio.sleep(.25); assert client.get_flag('enabled') == 'bootstrap'
        late = create(20)
        async def ignores_cancel(previous):
            try:
                await asyncio.sleep(.05)
            except asyncio.CancelledError:
                await asyncio.sleep(.03)
            return [FlagConfig(key='enabled', enabled=True, default_value='late', variations=[], rules=[])], [], '"late"'
        late.config_service._download = ignores_cancel
        with pytest.raises(ConfigRefreshError):
            await late.refresh_config()
        await asyncio.sleep(.1); assert late.get_flag('enabled') == 'bootstrap'
        manual = create(); manual.config_service._download = ignores_cancel
        replacing = asyncio.create_task(manual.refresh_config()); await asyncio.sleep(.01)
        manual.set_flags([FlagConfig(key='enabled', enabled=True, default_value='manual', variations=[], rules=[])])
        with pytest.raises(ConfigRefreshError):
            await replacing
        assert manual.get_flag('enabled') == 'manual'
        closing = create(); pending = asyncio.create_task(closing.refresh_config()); await asyncio.sleep(.01); closing.close_config()
        with pytest.raises(ConfigRefreshError):
            await pending
        await asyncio.sleep(.25); assert closing.get_flag('enabled') == 'bootstrap'
    asyncio.run(run())


def test_https_required_unless_explicit_local_opt_in(endpoint):
    _, create = endpoint
    options = create().options; options.config.allow_insecure_http = False
    with pytest.raises(ValueError, match='HTTPS'):
        UserFnClient(options)
