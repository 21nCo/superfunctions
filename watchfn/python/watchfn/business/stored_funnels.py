"""Stored funnel-v1 definitions and ordered canonical event evaluation."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
import re
from threading import RLock

from superfunctions.db import CreateParams, FindOneParams, WhereClause, FieldSchema, TableSchema, IndexSchema
from ..alerts.lifecycle import LifecycleCallbacks, owned_operation
from ..query import Query, QueryValidationError, read, equal, MISSING, js_string
from ..storage.database import DatabaseStorage
from ..storage.events import CanonicalBusinessEvent

TABLE = 'watchfn_business_definitions'


def get_business_schema():
    from ..alerts.schema import get_alert_schema
    return {**get_alert_schema(), TABLE: TableSchema(name=TABLE, fields=[
        FieldSchema(name='id', type='string', primary_key=True, unique=True),
        *[FieldSchema(name=key, type='string') for key in ('namespace', 'kind', 'name')],
        FieldSchema(name='payload', type='text'),
    ], indexes=[IndexSchema(name='watchfn_business_namespace', fields=['namespace', 'kind', 'name'])])}


def text(value, maximum=255):
    if not isinstance(value, str) or not value.strip(): return False
    try: return len(value.encode('utf-16-le')) // 2 <= maximum and bool(value.encode('utf-8'))
    except UnicodeEncodeError: return False


def scalar(value):
    return value is None or type(value) is bool or isinstance(value, str) and len(value.encode('utf-16-le')) // 2 <= 1024 or type(value) in (int, float) and math.isfinite(value)


def group_scalar(value):
    # JavaScript has one numeric type; normalize its JSON-visible zero/integer
    # representation without collapsing booleans into numeric groups.
    if type(value) in (int, float):
        number = float(value)
        return 0 if number == 0 else int(number) if number.is_integer() and abs(number) < 1e21 else number
    return value


def field(value):
    if not text(value) or any(not part or part in ('__proto__', 'constructor', 'prototype') for part in value.split('.')):
        raise ValueError('Invalid funnel field')


def duration(value):
    match = re.fullmatch(r'(\d+)(m|h|d|w)', value) if isinstance(value, str) else None
    if match is None: raise ValueError('Invalid funnel window')
    result = int(match[1]) * {'m': 60000, 'h': 3600000, 'd': 86400000, 'w': 604800000}[match[2]]
    if not 0 < result <= 366 * 86400000: raise ValueError('Funnel window exceeds one year')
    return result


def packed(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def validate(value):
    if (not isinstance(value, dict) or set(value) - {'name', 'steps', 'timeWindow'} or not text(value.get('name'))
            or not isinstance(value.get('steps'), list) or not 2 <= len(value['steps']) <= 32):
        raise ValueError('Invalid funnel definition')
    duration(value.get('timeWindow'))
    for step in value['steps']:
        if (not isinstance(step, dict) or set(step) - {'event', 'name', 'filters'} or not text(step.get('event'))
                or 'name' in step and not text(step['name'])): raise ValueError('Invalid funnel step')
        if 'filters' in step:
            if not isinstance(step['filters'], dict) or len(step['filters']) > 16: raise ValueError('Invalid funnel filters')
            for key, item in step['filters'].items():
                field(key)
                if not scalar(item): raise ValueError('Funnel filters require finite scalar values')
    raw = packed(value)
    if len(raw.encode('utf-8')) > 32768: raise ValueError('Funnel definition exceeds 32KiB')
    return json.loads(raw)


def funnel_timestamp(value):
    if type(value) in (int, float):
        if not math.isfinite(value) or abs(value) > 8640000000000000: raise QueryValidationError('Invalid funnel timestamp')
        return value
    if isinstance(value, datetime) and value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try: value = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError: raise QueryValidationError('Invalid funnel timestamp') from None
    if not isinstance(value, datetime) or value.tzinfo is None: raise QueryValidationError('Funnel timestamp requires timezone')
    elapsed = value.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return elapsed.days * 86400000 + elapsed.seconds * 1000 + elapsed.microseconds // 1000


class FunnelQuery(Query):
    _max_limit = 10000
    _timestamp = staticmethod(funnel_timestamp)


class StoredFunnels:
    def __init__(self, watch):
        self.watch = watch
        self._callbacks = LifecycleCallbacks()
        self._callbacks.stop()
        self._definitions = {}
        self._lock = RLock()

    def _active(self):
        if not self.watch.is_started: raise RuntimeError('WatchFn storage is unavailable')
        if not text(self.watch.config.name): raise ValueError('Invalid business namespace')

    def _id(self, name):
        return hashlib.sha256(packed([self.watch.config.name, 'funnel', name]).encode('utf-8')).hexdigest()

    @owned_operation
    def create_goal(self, options):
        self._active()
        return self.watch.alerts.create_goal(options, self.watch.config.name)

    @owned_operation
    def get_goal_progress(self, options):
        self._active()
        if not isinstance(options, dict) or set(options) != {'name','date'}: raise ValueError('Invalid goal progress query')
        options = deepcopy(options)
        from .goals import progress
        goal = self.watch.alerts.get_goal(options['name'], self.watch.config.name)
        self.watch.flush()
        return progress(self.watch.storage.query(), self.watch.config.name, goal, options['date'])

    @owned_operation
    def track(self, name, properties):
        self._active()
        if not text(name) or not isinstance(properties, dict): raise ValueError('Business events require a name and properties object')
        raw = packed({'type': 'track', 'name': name, 'app': {'name': self.watch.config.name}, 'timestamp': datetime.now(timezone.utc).isoformat(), 'properties': properties})
        if len(raw.encode('utf-8')) > 65536: raise ValueError('Business event exceeds 64KiB')
        event = CanonicalBusinessEvent.model_validate_json(raw)
        self.watch.batcher.add(event)

    @owned_operation
    def create_funnel(self, options):
        self._active()
        config = validate(options)
        row = {'id': self._id(config['name']), 'namespace': self.watch.config.name, 'kind': 'funnel', 'name': config['name'], 'payload': packed({'protocol': 'funnel-v1', 'config': config})}
        storage = self.watch.storage
        if isinstance(storage, DatabaseStorage):
            async def create(transaction):
                await transaction.create(CreateParams(model=TABLE, data=row))
            storage.run_transaction(create)
        else:
            with self._lock:
                if row['id'] in self._definitions: raise ValueError('Funnel already exists')
                self._definitions[row['id']] = deepcopy(row)
        return deepcopy(config)

    def _definition(self, name):
        if not text(name): raise ValueError('Invalid funnel name')
        storage = self.watch.storage
        if isinstance(storage, DatabaseStorage):
            async def find(transaction):
                return await transaction.find_one(FindOneParams(model=TABLE, where=[WhereClause(field='id', value=self._id(name)), WhereClause(field='namespace', value=self.watch.config.name)]))
            row = storage.run_transaction(find)
        else:
            with self._lock: row = deepcopy(self._definitions.get(self._id(name)))
        if row is None: raise ValueError('Funnel not found')
        payload = json.loads(row['payload']) if isinstance(row['payload'], str) else row['payload']
        if row['kind'] != 'funnel' or row['name'] != name or row['namespace'] != self.watch.config.name or payload.get('protocol') != 'funnel-v1': raise ValueError('Unsupported stored funnel definition')
        config = validate(payload['config'])
        if config['name'] != name: raise ValueError('Invalid stored funnel identity')
        return config

    @owned_operation
    def get_funnel(self, options):
        self._active()
        if not isinstance(options, dict) or set(options) - {'name', 'timeRange', 'groupBy'} or not text(options.get('name')) or options.get('timeRange') is None: raise ValueError('Invalid funnel query')
        if 'groupBy' in options: field(options['groupBy'])
        options = deepcopy(options)
        config = self._definition(options['name'])
        window = duration(config['timeWindow'])
        self.watch.flush()
        events = self.watch.storage.query()
        if len(events) > 10000: raise ValueError('Funnel candidate capacity exceeded')
        size = 0
        for event in events:
            length = len(event.model_dump_json().encode('utf-8')); size += length
            if length > 65536 or size > 16777216: raise ValueError('Funnel payload capacity exceeded')
        rows = FunnelQuery({'where': {'type': 'track'}, 'timeRange': options['timeRange'], 'limit': 10000}).execute(events)
        rows.sort(key=lambda row: funnel_timestamp(row['timestamp']))
        users, prior_states, batch_time, ignored = {}, {}, None, 0
        for row in rows:
            at = funnel_timestamp(row['timestamp'])
            if batch_time != at: batch_time, prior_states = at, {}
            matches = [row.get('name') == step['event'] and all(equal(read(row, key), value) for key, value in step.get('filters', {}).items()) for step in config['steps']]
            if not any(matches): continue
            app = row.get('app')
            if not isinstance(app, dict) or not isinstance(app.get('name'), str) or not app['name']: raise QueryValidationError('Business event ownership is missing; migrate legacy events before funnel evaluation')
            if app['name'] != self.watch.config.name: continue
            identity = read(row, 'userId')
            if not text(identity, 1024): ignored += 1; continue
            user = users.get(identity)
            group = read(row, options['groupBy']) if 'groupBy' in options else None
            if group is MISSING: group = None
            if user is None and matches[0]:
                if not scalar(group): raise ValueError('Funnel cohort group must be a finite scalar')
                user = {'depth': 0, 'starts': {}, 'group': group_scalar(group), 'entered': at}; users[identity] = user
            if user is None: continue
            if identity not in prior_states: prior_states[identity] = deepcopy(user['starts'])
            prior = prior_states[identity]
            if matches[0] and at == user['entered'] and 'groupBy' in options and (not scalar(group) or not equal(group, user['group'])): raise ValueError('Ambiguous first-entry funnel cohort')
            for index in range(len(config['steps']) - 1, 0, -1):
                previous = prior.get(index - 1)
                if matches[index] and previous and previous['last'] < at and at - previous['start'] <= window:
                    if index not in user['starts'] or previous['start'] > user['starts'][index]['start']: user['starts'][index] = {'start': previous['start'], 'last': at}
                    user['depth'] = max(user['depth'], index + 1)
            if matches[0]: user['starts'][0] = {'start': at, 'last': at}; user['depth'] = max(user['depth'], 1)
        def summarize(values):
            counts = [sum(user['depth'] > index for user in values) for index in range(len(config['steps']))]
            return {'steps': [{'event': step['event'], 'name': step.get('name', step['event']), 'count': counts[index], 'conversionRate': counts[index] / counts[index - 1] * 100 if index and counts[index - 1] else 0 if index or not counts[0] else 100} for index, step in enumerate(config['steps'])], 'overallConversion': counts[-1] / counts[0] * 100 if counts[0] else 0}
        result = {'name': config['name'], **summarize(list(users.values())), 'ignoredIdentityEvents': ignored, 'ordering': 'strict-timestamp'}
        if 'groupBy' in options:
            groups = {}
            for user in users.values():
                key = js_string(user['group']) if type(user['group']) in (int, float) else packed(user['group'])
                if key not in groups:
                    if len(groups) >= 1000: raise ValueError('Funnel group capacity exceeded')
                    groups[key] = {'group': user['group'], 'users': []}
                groups[key]['users'].append(user)
            result['groups'] = [{'group': group['group'], **summarize(group['users'])} for _, group in sorted(groups.items(), key=lambda item: item[0].encode('utf-8'))]
        return result

    @owned_operation
    def get_dropoff_analysis(self, options):
        self._active()
        if not isinstance(options, dict) or set(options) - {'funnel', 'step', 'timeRange', 'groupBy'} or type(options.get('step')) is not int or options['step'] < 1: raise ValueError('Invalid dropoff query')
        result = self.get_funnel({'name': options.get('funnel'), 'timeRange': options.get('timeRange'), **({'groupBy': options['groupBy']} if 'groupBy' in options else {})})
        step = options['step']
        if step >= len(result['steps']): raise ValueError('Dropoff step must precede another step')
        def summarize(value):
            entered, advanced = value['steps'][step - 1]['count'], value['steps'][step]['count']
            return {'entered': entered, 'advanced': advanced, 'dropped': entered - advanced, 'dropoffRate': (entered - advanced) / entered * 100 if entered else 0}
        return {'name': result['name'], 'step': step, **summarize(result), **({'groups': [{'group': group['group'], **summarize(group)} for group in result['groups']]} if 'groups' in result else {})}
