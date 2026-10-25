"""Owned, synchronous LogFn admission and canonical stored-log queries."""
from copy import deepcopy
from datetime import datetime
import json
import re
from threading import RLock, local

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..models import Event
from ..storage.events import encode_event
from ..query import Aggregate, Query, QueryValidationError, field

LEVELS = ('trace', 'debug', 'info', 'warn', 'error', 'fatal')


class LogIntegrationConfig(BaseModel):
    model_config = ConfigDict(extra='forbid', populate_by_name=True, validate_default=True)
    enabled: bool = Field(True, strict=True)
    auto_ingest: bool = Field(True, alias='autoIngest', strict=True)
    parse_structured: bool = Field(True, alias='parseStructured', strict=True)
    index_fields: list[str] = Field(default_factory=lambda: ['level', 'service', 'userId', 'traceId'], alias='indexFields', max_length=32)
    min_level: str = Field('trace', alias='minLevel', strict=True)

    @field_validator('min_level')
    @classmethod
    def level(cls, value):
        if value not in LEVELS:
            raise ValueError('Invalid log minimum level')
        return value

    @field_validator('index_fields', mode='before')
    @classmethod
    def field_list(cls, value):
        if not isinstance(value, list) or any(type(name) is not str for name in value):
            raise ValueError('Log index fields must be strings')
        return value

    @field_validator('index_fields')
    @classmethod
    def fields(cls, value):
        for name in value:
            field(name)
            if len(name) > 128 or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*', name):
                raise ValueError('Invalid log index field')
        return sorted(set(value))


def convert(batch, options, redact):
    if not isinstance(batch, list) or len(batch) > 1000:
        raise ValueError('Invalid log batch')
    events, size, normalized_size = [], 0, 0
    for value in batch:
        if not isinstance(value, dict) or value.get('level') not in LEVELS:
            raise ValueError('Invalid log event')
        if not all(isinstance(value.get(key), str) for key in ('ts', 'msg', 'name')):
            raise ValueError('Invalid log event')
        length = len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8'))
        size += length
        if size > 16 * 1024 * 1024:
            raise ValueError('Log batch exceeds 16 MiB')
        if length > 65536:
            raise ValueError('Log event exceeds 64 KiB')
        stamp = datetime.fromisoformat(value['ts'].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('Log timestamp requires timezone')
        if LEVELS.index(value['level']) < LEVELS.index(options.min_level):
            continue
        context = value.get('ctx', {})
        if not isinstance(context, dict):
            raise ValueError('Invalid log context')
        properties = {}
        message = value['msg']
        if options.parse_structured:
            try:
                def invalid_constant(value):
                    raise ValueError('Invalid JSON constant')
                parsed = json.loads(value['msg'], parse_constant=invalid_constant)
            except (ValueError, RecursionError):
                parsed = None
            if isinstance(parsed, dict):
                # Parsing reveals new sensitive key boundaries. Apply the producer's
                # terminal default policy again, never an index-derived allowlist.
                properties.update(redact(parsed))
                message = json.dumps(properties, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        properties.update(deepcopy(context))
        for key in ('traceId', 'spanId', 'requestId', 'userId', 'tenantId', 'tags'):
            if key in value:
                properties[key] = deepcopy(value[key])
        service = properties.get('service') if isinstance(properties.get('service'), str) else value['name']
        properties.update(message=message, level=value['level'], service=service)
        for key in ('type', 'timestamp', 'name'):
            properties.pop(key, None)
        event = Event(type='log', name=value['name'], timestamp=stamp, properties=properties)
        event._log_index_fields = tuple(options.index_fields)
        normalized_size += len(encode_event(event).encode('utf-8'))
        if normalized_size > 16 * 1024 * 1024:
            raise ValueError('Normalized log batch exceeds 16 MiB')
        events.append(event)
    return events


class LogRegistrations:
    def __init__(self, watch):
        self.watch = watch
        self.lock = RLock()
        self.local = local()
        self.entries = {}
        self.active = False

    def use(self, logger, options=None):
        if not callable(getattr(logger, 'add_sink', None)):
            raise TypeError('Integration requires LogFn add_sink support')
        configured = self.watch.config.integrations.get('logfn', {})
        if not isinstance(configured, dict):
            raise ValueError("Log integration configuration must be an object")
        if options is not None and not isinstance(options, dict):
            raise ValueError('Log integration options must be an object')
        policy = LogIntegrationConfig.model_validate({**configured, **(options or {})})
        try:
            from logfn import default_redactor
        except ImportError as error:
            raise RuntimeError('Install a LogFn version exposing add_sink and default_redactor') from error
        redact = default_redactor()
        with self.lock:
            previous = self.entries.get(id(logger))
            if previous is not None:
                if previous['options'] != policy:
                    raise ValueError('Detach the existing logger before changing options')
                return previous['detach']
            entry = {'logger': logger, 'options': policy, 'attached': None}
            def sink(batch):
                # Check before admission-lock acquisition: a background flush may
                # own delivery while another sink waits for it under this lock.
                if getattr(self.local, 'storing', False) or getattr(self.local, 'delivering', False):
                    raise RuntimeError('Reentrant log ingestion')
                with self.lock:
                    if not self.active or id(logger) not in self.entries:
                        return
                    if getattr(self.local, 'delivering', False):
                        raise RuntimeError("Reentrant log ingestion")
                    self.local.delivering = True
                    try:
                        events = convert(batch, policy, redact)
                        for event in events:
                            self.watch.batcher.add(event)
                        self.watch.batcher.flush()
                    finally:
                        self.local.delivering = False
            def detach():
                with self.lock:
                    if self.entries.get(id(logger)) is not entry:
                        return
                    if entry['attached'] is not None:
                        entry['attached']()
                    del self.entries[id(logger)]
            entry.update(sink=sink, detach=detach)
            self.entries[id(logger)] = entry
            if self.active and policy.enabled and policy.auto_ingest:
                entry['attached'] = logger.add_sink(sink)
            return detach

    def start(self):
        with self.lock:
            self.active = True
            for entry in self.entries.values():
                if entry['attached'] is None and entry['options'].enabled and entry['options'].auto_ingest:
                    entry['attached'] = entry['logger'].add_sink(entry['sink'])

    def stop(self):
        if getattr(self.local, 'delivering', False) or getattr(self.local, 'storing', False):
            raise RuntimeError('Cannot stop WatchFn from its log storage callback')
        with self.lock:
            self.active = False
            for entry in self.entries.values():
                if entry['attached'] is not None:
                    entry['attached']()
                    entry['attached'] = None


def query_options(options):
    if not isinstance(options, dict) or set(options) - {'level', 'search', 'filters', 'timeRange', 'orderBy', 'limit'}:
        raise QueryValidationError('Invalid log options')
    filters = options.get('filters', {})
    if not isinstance(filters, dict) or 'type' in filters:
        raise QueryValidationError('Log type cannot be overridden')
    where = {**filters, 'type': 'log'}
    if 'level' in options:
        if options['level'] not in (*LEVELS, 'warning') or 'level' in where:
            raise QueryValidationError('Invalid or duplicate log level')
        where['level'] = options['level']
    if 'search' in options:
        if not isinstance(options['search'], str) or len(options['search']) > 4096 or 'message' in where:
            raise QueryValidationError('Invalid or duplicate log search')
        where['message'] = {'contains': options['search']}
    return {**{key: options[key] for key in ('timeRange', 'orderBy', 'limit') if key in options}, 'where': where}


class Logs:
    def __init__(self, watch):
        self.watch = watch

    def _events(self, where):
        if not self.watch.is_started:
            raise RuntimeError('WatchFn storage is unavailable')
        self.watch.flush()
        return self.watch.storage.query_logs(where)

    def query(self, options):
        query = Query(query_options(options))
        return query.execute(self._events(query.options['where']))

    def aggregate(self, options):
        if not isinstance(options, dict):
            raise QueryValidationError('Invalid log aggregate options')
        if options.get('aggregation') == 'rate':
            raise QueryValidationError('Log aggregate rate is unsupported')
        aggregate = {key: value for key, value in options.items() if key in ('groupBy', 'aggregation', 'field', 'percentile')}
        query = query_options({key: value for key, value in options.items() if key not in aggregate})
        operation = Aggregate({**query, **aggregate})
        return operation.execute(self._events(query['where']))
