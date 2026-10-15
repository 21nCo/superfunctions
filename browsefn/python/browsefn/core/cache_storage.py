"""Atomic named cache persistence; database operations use shared db protocols."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import tempfile
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel
from browsefn.core import types


def encode(value: Any) -> Any:
    if isinstance(value, bytes):
        return ['bytes', base64.b64encode(value).decode('ascii')]
    if isinstance(value, datetime):
        return ['datetime', value.isoformat()]
    if isinstance(value, BaseModel):
        model = getattr(types, type(value).__name__, None)
        if model is not type(value):
            raise TypeError('Only BrowseFn model types can be persisted')
        return ['model', type(value).__name__, encode(value.model_dump())]
    if isinstance(value, tuple):
        return ['tuple', [encode(item) for item in value]]
    if isinstance(value, list):
        return ['array', [encode(item) for item in value]]
    if isinstance(value, dict):
        return ['object', [[key, encode(item)] for key, item in value.items()]]
    if value is None or isinstance(value, (str, bool, int)):
        return ['value', value]
    if isinstance(value, float) and math.isfinite(value):
        return ['value', value]
    raise TypeError('Cache data is not serializable')


def decode(value: Any) -> Any:
    tag = value[0]
    if tag == 'bytes':
        return base64.b64decode(value[1], validate=True)
    if tag == 'datetime':
        return datetime.fromisoformat(value[1])
    if tag == 'model':
        model = getattr(types, value[1], None)
        if not isinstance(model, type) or not issubclass(model, BaseModel):
            raise ValueError('Invalid cache model')
        return model.model_validate(decode(value[2]))
    if tag == 'tuple':
        return tuple(decode(item) for item in value[1])
    if tag == 'array':
        return [decode(item) for item in value[1]]
    if tag == 'object':
        return {key: decode(item) for key, item in value[1]}
    if tag == 'value':
        return value[1]
    raise ValueError('Invalid cache encoding')


def dumps(entries: OrderedDict) -> str:
    return json.dumps({'version': 1, 'entries': [[key, {'data': encode(entry.data), 'timestamp': entry.timestamp, 'ttl': entry.ttl}] for key, entry in entries.items()]}, allow_nan=False)


def loads(raw: str | None) -> OrderedDict:
    from browsefn.core.cache_manager import CacheEntry
    if raw is None:
        return OrderedDict()
    payload = json.loads(raw)
    if payload['version'] != 1:
        raise ValueError('Unsupported BrowseFn cache version')
    return OrderedDict((key, CacheEntry(data=decode(value['data']), timestamp=value['timestamp'], ttl=value['ttl'])) for key, value in payload['entries'])


class FileCacheStore:
    def __init__(self, config):
        self.root = Path(config.directory or '.browsefn-cache').resolve()
        self.name = hashlib.sha256((config.name or 'browsefn').encode()).hexdigest() + '.python.json'

    async def run(self, operation: Callable):
        return await asyncio.to_thread(self._run, operation)

    def _run(self, operation: Callable):
        # Advisory locks are released by the OS when a process exits.
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        target = self.root / self.name
        with (self.root / (self.name + '.lock')).open('a+b') as lock:
            if os.name == 'nt':
                import msvcrt
                lock.seek(0)
                if not lock.read(1):
                    lock.write(b'0')
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                if target.is_symlink():
                    raise ValueError('Cache file must not be a symlink')
                raw = target.read_text() if target.exists() else None
                entries = loads(raw)
                result = operation(entries)
                serialized = dumps(entries)
                fd, temporary = tempfile.mkstemp(dir=self.root, prefix=self.name, suffix='.tmp')
                try:
                    with os.fdopen(fd, 'w') as stream:
                        stream.write(serialized)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, target)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
                return result
            finally:
                if os.name == 'nt':
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def database_schema():
    from superfunctions.db import TableSchema, FieldSchema, FieldType
    return TableSchema(name='browsefn_cache', fields=[
        FieldSchema(name='id', type=FieldType.STRING, primaryKey=True),
        FieldSchema(name='value', type=FieldType.TEXT),
        FieldSchema(name='revision', type=FieldType.BIGINT),
    ])


class DatabaseCacheStore:
    def __init__(self, config):
        if config.database is None:
            raise ValueError('Database cache requires CacheConfig.database')
        self.adapter = config.database
        self.name = 'python:' + hashlib.sha256((config.name or 'browsefn').encode()).hexdigest()

    async def run(self, operation: Callable):
        from superfunctions.db import FindOneParams, CreateParams, UpdateManyParams, WhereClause
        where = [WhereClause(field='id', value=self.name)]
        for _ in range(32):
            row = await self.adapter.find_one(FindOneParams(model='browsefn_cache', where=where))
            entries = loads(row['value'] if row else None)
            result = operation(entries)
            value = dumps(entries)
            if row is None:
                try:
                    await self.adapter.create(CreateParams(model='browsefn_cache', data={'id': self.name, 'value': value, 'revision': 1}))
                    return result
                except Exception as error:
                    if getattr(error, 'code', None) not in {'DUPLICATE_KEY', 'CONSTRAINT_VIOLATION'}:
                        raise
            else:
                if value == row['value']:
                    return result
                revision = row['revision']
                if not isinstance(revision, int) or revision < 1 or revision >= 2**53 - 1:
                    raise ValueError('Invalid BrowseFn cache revision')
                changed = await self.adapter.update_many(UpdateManyParams(model='browsefn_cache', where=[*where, WhereClause(field='revision', value=revision)], data={'value': value, 'revision': revision + 1}))
                if changed == 1:
                    return result
                if changed > 1:
                    raise ValueError('BrowseFn cache database id must be unique')
        raise RuntimeError('BrowseFn cache contention: retry the operation')


class BridgeCacheStore:
    """Injected IndexedDB bridge, whose transaction callback atomically edits encoded state."""
    def __init__(self, config):
        if config.backend is None or not callable(getattr(config.backend, 'transaction', None)):
            raise ValueError('Python IndexedDB requires CacheConfig.backend with async transaction(name, callback)')
        self.backend = config.backend
        self.name = 'python:' + hashlib.sha256((config.name or 'browsefn').encode()).hexdigest()

    async def run(self, operation: Callable):
        def transaction(raw):
            entries = loads(raw)
            result = operation(entries)
            return dumps(entries), result
        return await self.backend.transaction(self.name, transaction)
