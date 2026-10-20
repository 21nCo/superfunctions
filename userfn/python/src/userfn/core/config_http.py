"""Host-pinned signed configuration. Optional dependencies load only on opt-in."""
import asyncio
import base64
import hashlib
import json
import re
from urllib.parse import urlsplit
from ..types import (FlagConfig, FlagVariation, FlagRule, FlagPrerequisite,
                     FlagEnvironmentOverride, Segment, SegmentRule)
from .flags import _validate_flags


class ConfigRefreshError(Exception):
    def __init__(self, message='Configuration refresh failed'):
        super().__init__(message)


def _decode(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ConfigRefreshError('Invalid configuration encoding')
    try:
        return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    except Exception:
        raise ConfigRefreshError('Invalid configuration encoding') from None


def _depth(value, depth=0):
    if depth > 20:
        raise ConfigRefreshError('Configuration nesting exceeds limit')
    if isinstance(value, (dict, list)):
        for child in value.values() if isinstance(value, dict) else value:
            _depth(child, depth + 1)


def _constraint(value):
    if not isinstance(value, dict):
        raise ConfigRefreshError('Invalid configuration constraint')
    return SegmentRule(id=value['id'], field=value['field'], operator=value['operator'], value=value.get('value'))


def _rule(value):
    if not isinstance(value, dict):
        raise ConfigRefreshError('Invalid configuration rule')
    if any(key in value and value[key] is None for key in ('segmentId', 'variationId', 'rolloutPercentage', 'constraints')):
        raise ConfigRefreshError('Invalid configuration rule')
    return FlagRule(id=value['id'], segment_id=value.get('segmentId'),
                    constraints=[_constraint(item) for item in value['constraints']] if 'constraints' in value else None,
                    rollout_percentage=value.get('rolloutPercentage'), variation_id=value.get('variationId'))


def _wire(value):
    flags = value.get('flags')
    segments = value.get('segments')
    if not isinstance(flags, list) or len(flags) > 1000 or not isinstance(segments, list) or len(segments) > 1000:
        raise ConfigRefreshError('Invalid configuration definitions')
    converted = []
    for flag in flags:
        if not isinstance(flag, dict) or ('defaultVariationId' in flag and flag['defaultVariationId'] is None):
            raise ConfigRefreshError('Invalid configuration flag')
        for prerequisite in flag.get('prerequisites', []):
            if not isinstance(prerequisite, dict) or set(prerequisite) != {'key', 'expectedValue'}:
                raise ConfigRefreshError('Invalid configuration prerequisite')
        overrides = {}
        for name, override in flag.get('environmentOverrides', {}).items():
            if not isinstance(override, dict) or set(override) - {'enabled', 'defaultValue', 'defaultVariationId', 'rules'}:
                raise ConfigRefreshError('Invalid configuration override')
            if 'enabled' in override and type(override['enabled']) is not bool:
                raise ConfigRefreshError('Invalid configuration override')
            fields = {}
            for key, target in [('enabled', 'enabled'), ('defaultValue', 'default_value'), ('defaultVariationId', 'default_variation_id')]:
                if key in override:
                    fields[target] = override[key]
            if 'rules' in override:
                fields['rules'] = [_rule(item) for item in override['rules']]
            overrides[name] = FlagEnvironmentOverride(**fields)
        converted.append(FlagConfig(key=flag['key'], enabled=flag['enabled'], default_value=flag['defaultValue'],
            variations=[FlagVariation(id=item['id'], value=item['value'], name=item.get('name')) for item in flag['variations']],
            rules=[_rule(item) for item in flag['rules']], default_variation_id=flag.get('defaultVariationId'),
            prerequisites=[FlagPrerequisite(key=item['key'], expected_value=item['expectedValue']) for item in flag.get('prerequisites', [])],
            environment_overrides=overrides))
    _validate_flags(converted)
    converted_segments = []
    ids = set()
    for segment in segments:
        if (not isinstance(segment, dict) or not isinstance(segment.get('id'), str) or not segment['id']
                or segment['id'] in ids or not isinstance(segment.get('name'), str) or not segment['name']
                or not isinstance(segment.get('rules'), list) or segment.get('matchType', 'all') not in ('all', 'any')):
            raise ConfigRefreshError('Invalid configuration segment')
        ids.add(segment['id'])
        rules = [_constraint(item) for item in segment['rules']]
        _validate_flags([FlagConfig(key='validation', enabled=True, default_value=False, variations=[], rules=[FlagRule(id='validation', constraints=rules)])])
        converted_segments.append(Segment(id=segment['id'], name=segment['name'], rules=rules, match_type=segment.get('matchType', 'all')))
    return converted, converted_segments


class HttpConfigService:
    def __init__(self, options):
        config = options.config
        endpoint = urlsplit(options.endpoint or '')
        if (endpoint.scheme not in ('http', 'https') or not endpoint.hostname or endpoint.username or endpoint.password
                or endpoint.query or endpoint.fragment or (endpoint.scheme == 'http' and config.allow_insecure_http is not True)
                or not options.api_key.strip()):
            raise ValueError('Signed configuration requires HTTPS (or explicit local HTTP opt-in), endpoint and API key')
        if (not options.environment or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', options.environment)
                or not isinstance(config.tenant_id, str) or not config.tenant_id.strip() or len(config.tenant_id) > 200):
            raise ValueError('Expected configuration tenant and environment are required')
        if type(config.timeout_ms) is not int or not 1 <= config.timeout_ms <= 60000:
            raise ValueError('Invalid configuration timeout')
        try:
            import httpx
            from cryptography.hazmat.primitives.serialization import load_der_public_key
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        except ImportError:
            raise ImportError('Install userfn[config] for signed configuration refresh') from None
        if not isinstance(config.trusted_keys, dict) or not config.trusted_keys:
            raise ValueError('Trusted configuration keys are required')
        self.keys = {}
        for key_id, encoded in config.trusted_keys.items():
            if not isinstance(key_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', key_id):
                raise ValueError('Invalid configuration key ID')
            raw = _decode(encoded)
            if len(raw) != 44:
                raise ValueError('Expected Ed25519 SPKI public key')
            key = load_der_public_key(raw)
            if not isinstance(key, Ed25519PublicKey):
                raise ValueError('Expected Ed25519 SPKI public key')
            self.keys[key_id] = key
        self.httpx = httpx
        self.url = options.endpoint.rstrip('/') + '/config/' + options.environment
        self.key, self.tenant, self.environment = options.api_key, config.tenant_id, options.environment
        self.timeout = config.timeout_ms / 1000
        self.etag = None
        self.generation = 0
        self.closed = False
        self.inflight = None

    def cancel_pending(self):
        self.generation += 1
        if self.inflight and not self.inflight.done():
            self.inflight.cancel()

    async def cancel(self):
        self.cancel_pending()
        if self.inflight and not self.inflight.done():
            try:
                await self.inflight
            except (ConfigRefreshError, asyncio.CancelledError):
                pass

    def invalidate(self):
        self.etag = None
        self.generation += 1

    def close(self):
        self.closed = True
        self.invalidate()
        if self.inflight:
            self.inflight.cancel()

    async def refresh(self, apply):
        if self.closed:
            raise ConfigRefreshError('Configuration transport is closed')
        if self.inflight is None or self.inflight.done():
            self.inflight = asyncio.create_task(self._perform(apply))
            self.inflight.add_done_callback(self._observe)
        generation = self.generation
        try:
            return await asyncio.shield(self.inflight)
        except asyncio.CancelledError:
            if self.closed or generation != self.generation:
                raise ConfigRefreshError('Configuration request cancelled') from None
            raise

    @staticmethod
    def _observe(task):
        if not task.cancelled():
            task.exception()

    async def _perform(self, apply):
        generation, previous = self.generation, self.etag
        deadline = asyncio.get_running_loop().time() + self.timeout
        task = asyncio.create_task(self._download(previous))
        task.add_done_callback(self._observe)
        try:
            done, _ = await asyncio.wait({task}, timeout=self.timeout)
            if not done:
                raise ConfigRefreshError('Configuration request timed out')
            result = task.result()
            if asyncio.get_running_loop().time() > deadline:
                raise ConfigRefreshError('Configuration request timed out')
            if self.closed or generation != self.generation:
                raise ConfigRefreshError('Configuration changed during refresh')
            if result is None:
                return False
            flags, segments, etag = result
            apply(flags, segments)
            self.etag = etag
            return True
        except asyncio.CancelledError:
            raise ConfigRefreshError('Configuration request cancelled') from None
        except ConfigRefreshError:
            raise
        except Exception:
            raise ConfigRefreshError() from None
        finally:
            if not task.done():
                task.cancel()

    async def _download(self, previous):
        headers = {'Authorization': 'Bearer ' + self.key, 'Accept-Encoding': 'identity'}
        if previous:
            headers['If-None-Match'] = previous
        async with self.httpx.AsyncClient(timeout=self.timeout, follow_redirects=False, trust_env=False) as client:
            async with client.stream('GET', self.url, headers=headers) as response:
                if response.status_code == 304:
                    if not previous or response.headers.get('etag') != previous:
                        raise ConfigRefreshError('Unverified conditional configuration response')
                    return None
                if response.status_code != 200:
                    raise ConfigRefreshError('Configuration HTTP response was not successful')
                if response.headers.get('content-encoding', 'identity') != 'identity':
                    raise ConfigRefreshError('Compressed configuration is not supported')
                length = response.headers.get('content-length')
                if length is not None and (not length.isdigit() or int(length) > 270336):
                    raise ConfigRefreshError('Configuration response exceeds limit')
                chunks, size = [], 0
                # Decoded bytes are the signed HTTP representation; cap decoded size too.
                async for chunk in response.aiter_bytes(chunk_size=16384):
                    size += len(chunk)
                    if size > 270336 or len(chunks) >= 4096:
                        raise ConfigRefreshError('Configuration response exceeds limit')
                    chunks.append(chunk)
                raw = b''.join(chunks)
                value = json.loads(raw.decode('utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))
                _depth(value)
                if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1
                        or value.get('algorithm') != 'Ed25519' or value.get('tenantId') != self.tenant
                        or value.get('environment') != self.environment or not isinstance(value.get('revision'), str)
                        or not re.fullmatch(r'[a-f0-9-]{36}', value['revision']) or not isinstance(value.get('keyId'), str)):
                    raise ConfigRefreshError('Configuration identity mismatch')
                key = self.keys.get(value['keyId'])
                if key is None:
                    raise ConfigRefreshError('Untrusted configuration key')
                signature = _decode(response.headers.get('x-userfn-signature', ''))
                if len(signature) != 64:
                    raise ConfigRefreshError('Invalid configuration signature')
                key.verify(signature, raw)
                etag = '"' + hashlib.sha256(raw).hexdigest() + '"'
                if response.headers.get('etag') != etag:
                    raise ConfigRefreshError('Configuration ETag mismatch')
                flags, segments = _wire(value)
                return flags, segments, etag
