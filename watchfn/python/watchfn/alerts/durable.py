"""Durable definitions, lifecycle and pending notification obligations.

All operations use the existing Watch DB owner loop and shared adapter.
Explicit dispatch and reconciliation are implemented by the owned dispatcher.
"""
from copy import deepcopy
import json
import time
from urllib.parse import urlsplit
from uuid import uuid4
from superfunctions.db import AdapterError, CreateParams, FindOneParams, FindManyParams, OrderBy, WhereClause, UpdateManyParams
from .schema import ALERTS, OUTBOX
from .alert_manager import Alert, EvaluationResult
from .observations import validate, ranges, evaluate
from ..query import number


class AlertConflict(RuntimeError):
    pass


def text(value, maximum):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum


def encode(value, maximum=524288):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    if len(raw.encode('utf-8')) > maximum: raise ValueError('Alert payload capacity exceeded')
    return raw


class DurableAlertManager:
    def __init__(self, storage, snapshot, namespace, max_pending=100, active=lambda: True):
        if not text(namespace, 128): raise ValueError('Invalid alert namespace')
        if type(max_pending) is not int or not 1 <= max_pending <= 1000: raise ValueError('Invalid notification capacity')
        self.storage, self.snapshot, self.namespace = storage, snapshot, namespace
        self.max_pending = max_pending
        self.active = active

    def _where(self, identifier=None):
        return [WhereClause(field='namespace', value=self.namespace)] + ([WhereClause(field='id', value=identifier)] if identifier else [])

    def _run(self, action):
        async def transaction(tx):
            if not callable(getattr(tx, 'update_many', None)):
                raise RuntimeError('Durable alerts require atomic transaction.update_many')
            return await action(tx)
        try:
            return self.storage.run_transaction(transaction)
        except AdapterError:
            # Shared adapter errors can include SQL parameters/credential-bearing JSON.
            raise RuntimeError('Alert storage operation failed') from None

    def _definition(self, source):
        if not isinstance(source, dict): raise ValueError('Invalid alert definition')
        value = deepcopy(source)
        if not text(value.get('name'), 255) or not isinstance(value.get('channels'), list) or len(value['channels']) > 10:
            raise ValueError('Invalid alert definition')
        validate(value.get('condition'))
        def canonical_condition(rule):
            if rule.get('type') == 'composite':
                for child in rule['conditions']: canonical_condition(child)
            elif rule.get('type') == 'anomaly' and 'min_data_points' in rule:
                rule.setdefault('minDataPoints', rule['min_data_points'])
                del rule['min_data_points']
        canonical_condition(value['condition'])
        if 'enabled' in value and type(value['enabled']) is not bool: raise ValueError('Invalid enabled value')
        if 'severity' in value and value['severity'] not in ('info', 'warning', 'error', 'critical'): raise ValueError('Invalid severity')
        for key, maximum in [('description', 4096), ('runbook', 2048)]:
            if key in value and not text(value[key], maximum): raise ValueError('Invalid alert metadata')
        if 'tags' in value and (not isinstance(value['tags'], list) or len(value['tags']) > 32 or any(not text(tag, 128) for tag in value['tags'])):
            raise ValueError('Invalid alert tags')
        if 'autoResolve' in value:
            recovery = value['autoResolve']
            if not isinstance(recovery, dict) or type(recovery.get('enabled')) is not bool: raise ValueError('Invalid autoResolve')
            validate(recovery.get('condition'))
            canonical_condition(recovery['condition'])
        for channel in value['channels']:
            if not isinstance(channel, dict) or channel.get('type') not in ('email', 'slack', 'webhook', 'pagerduty'):
                raise ValueError('Unsupported alert channel')
            if channel['type'] in ('slack', 'webhook'):
                try: url = urlsplit(channel.get('webhook', ''))
                except ValueError: raise ValueError('Invalid alert webhook') from None
                if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.fragment or not text(channel.get('webhook'), 4096):
                    raise ValueError('Invalid alert webhook')
            if channel['type'] == 'email' and (not isinstance(channel.get('recipients'), list) or not 1 <= len(channel['recipients']) <= 100 or any(not text(item, 320) for item in channel['recipients'])):
                raise ValueError('Invalid email recipients')
            if channel['type'] == 'pagerduty' and not text(channel.get('integrationKey'), 1024): raise ValueError('Invalid integration key')
        allowed = ('name', 'condition', 'channels', 'enabled', 'severity', 'description', 'runbook', 'tags', 'autoResolve')
        value = {key: value[key] for key in allowed if key in value}
        encode(value, 32768)
        return value

    def _decode(self, row):
        if not row or not isinstance(row.get('payload'), str) or len(row['payload'].encode('utf-8')) > 524288:
            raise ValueError('Invalid stored alert')
        record = json.loads(row['payload'])
        if (not isinstance(record, dict) or not text(record.get('id'), 128) or record.get('id') != row.get('id') or row.get('namespace') != self.namespace
                or type(record.get('enabled')) is not bool or record.get('state') != row.get('state')
                or record.get('state') not in ('normal', 'triggered', 'acknowledged', 'resolved')
                or type(row.get('revision')) is not int or not 0 <= row['revision'] <= 9007199254740991
                or type(record.get('pendingNotifications')) is not int or not 0 <= record['pendingNotifications'] <= 1000
                or not isinstance(record.get('notes'), list) or len(record['notes']) > 100):
            raise ValueError('Invalid stored alert')
        for key in ('createdAt', 'updatedAt'):
            if not number(record.get(key)): raise ValueError('Invalid stored alert timestamp')
        for key in ('triggeredAt', 'resolvedAt', 'lastEvaluated'):
            if key in record and not number(record[key]): raise ValueError('Invalid stored alert timestamp')
        for note in record['notes']:
            if not isinstance(note, dict) or not text(note.get('content'), 4096) or not text(note.get('createdBy'), 255) or not number(note.get('createdAt')):
                raise ValueError('Invalid stored alert note')
        if record['state'] == 'acknowledged' and not text(record.get('acknowledgedBy'), 255): raise ValueError('Invalid stored acknowledgement')
        if record['state'] == 'resolved' and not text(record.get('resolvedBy'), 255): raise ValueError('Invalid stored resolution')
        self._definition(record)
        return record

    async def _row(self, tx, identifier):
        if not text(identifier, 128): raise ValueError('Invalid alert ID')
        row = await tx.find_one(FindOneParams(model=ALERTS, where=self._where(identifier)))
        if row is None: raise KeyError('Alert not found')
        return row

    def _public(self, record):
        value = deepcopy(record)
        from importlib.util import find_spec
        http_available = find_spec('httpx') is not None
        value['channels'] = [{'type': item['type'], 'configured': http_available and item['type'] in ('webhook', 'slack')} for item in value['channels']]
        return value

    def _legacy(self, record):
        return Alert(id=record['id'], name=record['name'], description=record.get('description'), enabled=record.get('enabled', True),
                     condition=deepcopy(record['condition']), severity=record.get('severity', 'warning'), channels=[channel['type'] for channel in record['channels']],
                     state=record['state'], triggered_at=record.get('triggeredAt'), last_evaluated=record.get('lastEvaluated'), auto_resolve=deepcopy(record.get('autoResolve')))

    def create(self, definition):
        return self._create(self._definition(definition), str(uuid4()), False)

    def _create(self, definition, identifier, if_absent):
        async def action(tx):
            existing = await tx.find_one(FindOneParams(model=ALERTS, where=self._where(identifier)))
            if existing:
                record = self._decode(existing)
                old = self._definition(record)
                if if_absent and dict(old, enabled=old.get('enabled', True)) == dict(definition, enabled=definition.get('enabled', True)):
                    return self._public(record)
                raise AlertConflict('Alert already exists with a different definition; use update')
            now = int(time.time() * 1000)
            record = dict(definition, id=identifier, enabled=definition.get('enabled', True), state='normal', createdAt=now, updatedAt=now, notes=[], pendingNotifications=0)
            await tx.create(CreateParams(model=ALERTS, data={'id': identifier, 'namespace': self.namespace, 'state': 'normal', 'revision': 0, 'payload': encode(record)}))
            return self._public(record)
        return self._run(action)

    def register(self, alert):
        if not isinstance(alert, Alert) or not text(alert.id, 128): raise ValueError('Invalid legacy alert')
        if any(not isinstance(channel, dict) for channel in alert.channels):
            raise ValueError('Durable registration requires trusted full channel configurations, not public channel names')
        definition = dict(name=alert.name, enabled=alert.enabled, condition=alert.condition, severity=alert.severity, channels=alert.channels)
        if alert.description is not None: definition['description'] = alert.description
        if alert.auto_resolve is not None: definition['autoResolve'] = alert.auto_resolve
        self._create(self._definition(definition), alert.id, True)

    def get_record(self, identifier):
        async def action(tx): return self._public(self._decode(await self._row(tx, identifier)))
        return self._run(action)

    def get(self, identifier):
        async def action(tx): return self._legacy(self._decode(await self._row(tx, identifier)))
        try: return self._run(action)
        except KeyError: return None

    def _limit(self, limit):
        if type(limit) is not int or not 1 <= limit <= 100: raise ValueError('Alert page limit must be 1..100')
        return limit

    def _rows(self, limit=50, after=None, status=None):
        self._limit(limit)
        if after is not None and not text(after, 128): raise ValueError('Invalid alert cursor')
        if status is not None and status not in ('normal', 'triggered', 'acknowledged', 'resolved'): raise ValueError('Invalid alert status')
        async def action(tx):
            where = self._where()
            if after is not None: where.append(WhereClause(field='id', operator='gt', value=after))
            if status is not None: where.append(WhereClause(field='state', value=status))
            return await tx.find_many(FindManyParams(model=ALERTS, where=where, order_by=[OrderBy(field='id')], limit=limit))
        return self._run(action)

    def list(self, *, limit=50, after=None, status=None):
        return [self._public(self._decode(row)) for row in self._rows(limit, after, status)]

    def get_all(self):
        rows = self._rows(100)
        if len(rows) == 100 and self._rows(1, rows[-1]['id']): raise ValueError('Use paginated alert list')
        return [self._legacy(self._decode(row)) for row in rows]

    def get_triggered(self):
        return [alert for alert in self.get_all() if alert.state in ('triggered', 'acknowledged')]

    def _mutate(self, identifier, change, expected=None, now=None):
        now = time.time() * 1000 if now is None else now
        async def action(tx):
            row = await self._row(tx, identifier)
            if expected is not None and row['revision'] != expected: raise AlertConflict('Alert changed during observation; retry')
            record = self._decode(row)
            if row['revision'] == 9007199254740991: raise ValueError('Alert revision capacity reached')
            transition = change(record, now)
            if transition and record['pendingNotifications'] + len(record['channels']) > self.max_pending:
                raise ValueError('Alert notification capacity reached; dispatcher required')
            record['updatedAt'] = now
            if transition: record['pendingNotifications'] += len(record['channels'])
            count = await tx.update_many(UpdateManyParams(model=ALERTS, where=self._where(identifier) + [WhereClause(field='revision', value=row['revision'])], data={'revision': row['revision'] + 1, 'state': record['state'], 'payload': encode(record)}))
            if count != 1: raise AlertConflict('Concurrent alert update; retry')
            if transition:
                for channel in record['channels']:
                    job = str(uuid4())
                    notification = {'id': job, 'event': transition, 'timestamp': now, 'alert': {key: record[key] for key in ('id', 'name', 'state', 'description', 'runbook', 'triggeredAt') if key in record}}
                    notification['alert']['severity'] = record.get('severity', 'warning')
                    await tx.create(CreateParams(model=OUTBOX, data={'id': job, 'namespace': self.namespace, 'alertId': identifier, 'revision': 0, 'state': 'pending', 'availableAt': int(now), 'leaseToken': None, 'attempts': 0, 'payload': encode({'notification': notification, 'channel': channel})}))
            return record
        return self._run(action)

    def update(self, identifier, definition):
        definition = self._definition(definition)
        def change(record, now):
            for key in ('description', 'severity', 'tags', 'runbook', 'autoResolve'): record.pop(key, None)
            record.update(dict(definition, enabled=definition.get('enabled', record['enabled'])))
        return self._public(self._mutate(identifier, change))

    def _note(self, record, content, actor, now):
        if not text(content, 4096) or not text(actor, 255): raise ValueError('Invalid alert note')
        if len(record['notes']) >= 100: raise ValueError('Alert note capacity reached')
        record['notes'].append({'content': content, 'createdBy': actor, 'createdAt': now})

    def add_note(self, identifier, *, content, created_by):
        return self._public(self._mutate(identifier, lambda record, now: self._note(record, content, created_by, now)))

    def acknowledge(self, identifier, *, acknowledged_by, note=None):
        if not text(acknowledged_by, 255): raise ValueError('Acknowledgement actor is required')
        def change(record, now):
            if record['state'] == 'acknowledged': return
            if record['state'] != 'triggered': raise ValueError('Only triggered alerts can be acknowledged')
            record.update(state='acknowledged', acknowledgedBy=acknowledged_by)
            if note is not None: self._note(record, note, acknowledged_by, now)
            return 'acknowledged'
        return self._public(self._mutate(identifier, change))

    def resolve(self, identifier, *, resolved_by, resolution=None):
        if not text(resolved_by, 255): raise ValueError('Resolution actor is required')
        def change(record, now):
            if record['state'] not in ('triggered', 'acknowledged'): return
            record.update(state='resolved', resolvedBy=resolved_by, resolvedAt=now)
            if resolution is not None: self._note(record, resolution, resolved_by, now)
            return 'resolved'
        return self._public(self._mutate(identifier, change))

    def _trigger(self, record, now):
        record.update(state='triggered', triggeredAt=now)
        for key in ('resolvedAt', 'resolvedBy', 'acknowledgedBy'): record.pop(key, None)
        return 'triggered'

    def trigger(self, identifier):
        return self._public(self._mutate(identifier, lambda record, now: self._trigger(record, now) if record['enabled'] and record['state'] not in ('triggered', 'acknowledged') else None))

    def enable(self, identifier):
        return self._public(self._mutate(identifier, lambda record, now: record.__setitem__('enabled', True)))

    def disable(self, identifier):
        return self._public(self._mutate(identifier, lambda record, now: record.__setitem__('enabled', False)))

    def evaluate_stored(self, *, now=None, maximum=10000, limit=50, after=None):
        now = time.time() * 1000 if now is None else now
        if not number(now): raise ValueError('Evaluation time must be finite')
        if type(maximum) is not int or not 1 <= maximum <= 1000000: raise ValueError('Invalid observation capacity')
        rows = self._rows(limit, after)
        requested = {}
        for row in rows:
            record = self._decode(row)
            if not record['enabled']: continue
            ranges(record['condition'], now, requested)
            if record.get('autoResolve', {}).get('enabled'): ranges(record['autoResolve']['condition'], now, requested)
        data = self.snapshot(requested, now, maximum)
        results = []
        for row in rows:
            before = self._decode(row)
            if not before['enabled']: continue
            matched = evaluate(before['condition'], data, now)
            recovery = evaluate(before['autoResolve']['condition'], data, now) if before.get('autoResolve', {}).get('enabled') else None
            def change(record, moment):
                if record.get('lastEvaluated', -float('inf')) > moment: raise AlertConflict('Evaluation time moved backwards')
                record['lastEvaluated'] = moment
                if matched is True and record['state'] not in ('triggered', 'acknowledged'): return self._trigger(record, moment)
                if record['state'] in ('triggered', 'acknowledged') and recovery is True:
                    record.update(state='resolved', resolvedBy='autoResolve', resolvedAt=moment)
                    return 'resolved'
            record = self._mutate(row['id'], change, row['revision'], now)
            results.append(EvaluationResult(self._legacy(record), matched is True, now, matched=matched, observed=matched is not None))
        return results

    def notifications(self, *, limit=50, after=None):
        self._limit(limit)
        if after is not None and not text(after, 128): raise ValueError('Invalid notification cursor')
        async def action(tx):
            rows = await tx.find_many(FindManyParams(model=OUTBOX, where=self._where() + ([WhereClause(field='id', operator='gt', value=after)] if after else []), order_by=[OrderBy(field='id')], limit=limit))
            return [dict({key: row[key] for key in ('id', 'alertId', 'state', 'attempts', 'availableAt')}, outcome=json.loads(row['payload']).get('delivery', {}).get('outcome', 'pending')) for row in rows]
        return self._run(action)

    def process_notifications(self, **kwargs):
        from .dispatch import Dispatcher
        return Dispatcher(self, **kwargs).process()

    def reconcile_notification(self, identifier, *, outcome, actor, reason):
        from .dispatch import Dispatcher
        return Dispatcher(self).reconcile(identifier, outcome, actor, reason)

    def evaluate(self, *args, **kwargs):
        raise ValueError('Use evaluate_stored for durable alerts; caller arrays cannot update persisted lifecycle')

    evaluate_all = evaluate

    def remove(self, identifier):
        raise NotImplementedError('Durable deletion requires notification reconciliation; disable the alert instead')
