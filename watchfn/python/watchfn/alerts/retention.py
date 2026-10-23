"""Host-driven receipt maintenance; unresolved operational dependencies stay pinned."""
import time
from superfunctions.db import FindOneParams, FindManyParams, UpdateManyParams, DeleteParams, WhereClause, OrderBy
from .schema import ALERTS, OUTBOX, RUNTIME
from .durable import AlertConflict
from .dispatch import Dispatcher, PROTOCOL

MIGRATING = 'python-v1-receipts-migrating'


def integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def identity(value):
    return isinstance(value, str) and len(value) > 0


def projection(row, value):
    delivery, metadata = value.get('delivery', {}), value.get('pagerDuty')
    terminal = delivery.get('outcome') in ('delivered', 'dismissed')
    if value.get('channel', {}).get('type') == 'pagerduty' and not metadata: raise ValueError('Legacy PagerDuty job requires explicit incident migration')
    if terminal and (row['state'] != 'dead' or not integer(delivery.get('completedAt')) or value.get('channel')):
        raise ValueError('Invalid terminal receipt')
    if metadata and (not identity(metadata.get('episode')) or not identity(metadata.get('route'))
                     or (metadata.get('predecessor') is not None and not identity(metadata.get('predecessor')))
                     or (metadata.get('predecessorEpisode') is not None and not identity(metadata.get('predecessorEpisode')))
                     or bool(metadata.get('predecessor')) != bool(metadata.get('predecessorEpisode'))):
        raise ValueError('Invalid PagerDuty dependency metadata')
    return {'completedAt': delivery['completedAt'] if terminal else None,
            'predecessorId': None if delivery.get('outcome') == 'delivered' else (metadata or {}).get('predecessor')}


def validate_projection(row, value):
    expected = projection(row, value)
    if any(key not in row or row[key] != wanted for key, wanted in expected.items()):
        raise ValueError('Receipt projection requires migration or repair')


class Retention:
    def __init__(self, manager):
        self.manager = manager
        self.dispatcher = Dispatcher(manager)

    def limit(self, value):
        if type(value) is not int or not 1 <= value <= 1000: raise ValueError('Retention page limit must be 1..1000')
        return value

    async def owner(self, tx):
        return await tx.find_one(FindOneParams(model=RUNTIME, where=[WhereClause(field='id', value=self.manager.namespace)]))

    async def validate_job(self, tx, row):
        value = self.dispatcher.payload(row)
        if await tx.find_one(FindOneParams(model=ALERTS, where=self.manager._where(row['alertId']))) is None:
            raise ValueError('Receipt owner missing')
        if row['predecessorId']:
            prior = await tx.find_one(FindOneParams(model=OUTBOX, where=self.manager._where(row['predecessorId'])))
            if prior is None: raise ValueError('Receipt predecessor missing')
            previous = self.dispatcher.payload(prior).get('pagerDuty', {})
            metadata = value['pagerDuty']
            prior_value = self.dispatcher.payload(prior)
            if (prior['alertId'] != row['alertId'] or previous.get('route') != metadata['route']
                    or previous.get('episode') != metadata['predecessorEpisode'] or prior['id'] == row['id']
                    or (value['notification']['event'] == 'triggered' and (prior_value['notification']['event'] != 'resolved' or previous.get('episode') == metadata['episode']))
                    or (value['notification']['event'] != 'triggered' and previous.get('episode') != metadata['episode'])):
                raise ValueError('Receipt predecessor identity mismatch')
        return value

    def status(self):
        async def action(tx):
            owner = await self.owner(tx)
            return {'protocol': owner['protocol'], 'phase': owner.get('migrationPhase'), 'cursor': owner.get('migrationCursor'), 'revision': owner.get('migrationRevision')} if owner else None
        return self.manager._run(action)

    def migrate(self, limit):
        self.limit(limit)
        async def action(tx):
            owner = await self.owner(tx)
            if owner is None: raise ValueError('Migration requires an existing python-v1 namespace')
            if owner['protocol'] == PROTOCOL: return {'done': True, 'phase': None, 'cursor': None, 'processed': 0}
            if owner['protocol'] not in ('python-v1', MIGRATING): raise ValueError('Migration requires an existing python-v1 namespace')
            initial = owner['protocol'] == 'python-v1'
            phase, cursor, revision = ('backfill', None, 0) if initial else (owner.get('migrationPhase'), owner.get('migrationCursor'), owner.get('migrationRevision'))
            if phase not in ('backfill', 'alerts', 'dependencies') or (cursor is not None and not identity(cursor)) or not integer(revision) or revision >= 9007199254740991:
                raise ValueError('Invalid durable migration progress')
            model = ALERTS if phase == 'alerts' else OUTBOX
            rows = await tx.find_many(FindManyParams(model=model, where=self.manager._where() + ([WhereClause(field='id', operator='gt', value=cursor)] if cursor else []), order_by=[OrderBy(field='id')], limit=limit + 1))
            page = rows[:limit]
            for row in page:
                if not identity(row.get('id')): raise ValueError('Invalid migration row identity')
                if phase == 'backfill':
                    value = self.dispatcher.payload(row, legacy=True)
                    count = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(row['id']) + [WhereClause(field='revision', value=row['revision'])], data={**projection(row, value), 'revision': row['revision'] + 1}))
                    if count != 1: raise AlertConflict('Concurrent receipt migration')
                elif phase == 'alerts':
                    record = self.manager._decode(row)
                    sequence = record.get('pagerDuty')
                    if not sequence and record['state'] in ('triggered', 'acknowledged') and any(channel['type'] == 'pagerduty' for channel in record['channels']):
                        raise ValueError('Legacy PagerDuty incident requires explicit migration')
                    for route, identifier in (sequence or {}).get('tails', {}).items():
                        tail = await tx.find_one(FindOneParams(model=OUTBOX, where=self.manager._where(identifier)))
                        if tail is None: raise ValueError('Current PagerDuty tail missing')
                        value = await self.validate_job(tx, tail)
                        metadata = value.get('pagerDuty', {})
                        if tail['alertId'] != row['id'] or metadata.get('route') != route or metadata.get('episode') != sequence['episode']:
                            raise ValueError('Current PagerDuty tail identity mismatch')
                else:
                    await self.validate_job(tx, row)
            if len(rows) > limit: cursor = page[-1]['id']
            else:
                cursor = None
                phase = 'alerts' if phase == 'backfill' else 'dependencies' if phase == 'alerts' else None
            where = [WhereClause(field='id', value=self.manager.namespace), WhereClause(field='protocol', value=owner['protocol'])]
            if not initial: where.append(WhereClause(field='migrationRevision', value=revision))
            changed = await tx.update_many(UpdateManyParams(model=RUNTIME, where=where, data={'protocol': MIGRATING if phase else PROTOCOL, 'migrationPhase': phase, 'migrationCursor': cursor, 'migrationRevision': revision + 1}))
            if changed != 1: raise AlertConflict('Concurrent migration progress')
            return {'done': phase is None, 'phase': phase, 'cursor': cursor, 'processed': len(page)}
        return self.manager._run(action)

    def prune(self, completed_before, limit, after):
        self.limit(limit)
        if not integer(completed_before) or completed_before > int(time.time() * 1000) or (after is not None and (not isinstance(after, dict) or not integer(after.get('completedAt')) or not identity(after.get('id')))):
            raise ValueError('Invalid receipt retention boundary/cursor')
        async def action(tx):
            if not callable(getattr(tx, 'delete', None)): raise RuntimeError('Receipt retention requires transaction.delete')
            order = [OrderBy(field='completedAt'), OrderBy(field='id')]
            base = self.manager._where() + [WhereClause(field='completedAt', operator='lt', value=completed_before), WhereClause(field='completedAt', operator='gte', value=0), WhereClause(field='completedAt', operator='ne', value=None)]
            same = await tx.find_many(FindManyParams(model=OUTBOX, where=base + [WhereClause(field='completedAt', value=after['completedAt']), WhereClause(field='id', operator='gt', value=after['id'])], order_by=order, limit=limit)) if after else []
            later = await tx.find_many(FindManyParams(model=OUTBOX, where=base + ([WhereClause(field='completedAt', operator='gt', value=after['completedAt'])] if after else []), order_by=order, limit=limit - len(same))) if len(same) < limit else []
            rows, deleted, pinned = same + later, 0, 0
            for row in rows:
                value = await self.validate_job(tx, row)
                if not integer(row['completedAt']) or value.get('delivery', {}).get('outcome') not in ('delivered', 'dismissed'): raise ValueError('Nonterminal receipt selected')
                alert = await self.manager._row(tx, row['alertId'])
                record = self.manager._decode(alert)
                if not integer(alert['revision']) or alert['revision'] >= 9007199254740991: raise ValueError('Invalid receipt owner')
                incoming = await tx.find_one(FindOneParams(model=OUTBOX, where=self.manager._where() + [WhereClause(field='predecessorId', value=row['id'])]))
                if incoming is not None: self.dispatcher.payload(incoming)
                if row['id'] in record.get('pagerDuty', {}).get('tails', {}).values() or incoming is not None:
                    pinned += 1
                    continue
                changed = await tx.update_many(UpdateManyParams(model=ALERTS, where=self.manager._where(alert['id']) + [WhereClause(field='revision', value=alert['revision'])], data={'revision': alert['revision'] + 1}))
                if changed != 1: raise AlertConflict('Concurrent receipt owner update')
                claimed = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(row['id']) + [WhereClause(field='revision', value=row['revision'])], data={'revision': row['revision'] + 1}))
                if claimed != 1: raise AlertConflict('Concurrent receipt deletion')
                await tx.delete(DeleteParams(model=OUTBOX, where=self.manager._where(row['id']) + [WhereClause(field='revision', value=row['revision'] + 1)]))
                if await tx.find_one(FindOneParams(model=OUTBOX, where=self.manager._where(row['id']))) is not None: raise AlertConflict('Receipt deletion was not applied')
                deleted += 1
            return {'scanned': len(rows), 'deleted': deleted, 'pinned': pinned, 'nextCursor': {'completedAt': rows[-1]['completedAt'], 'id': rows[-1]['id']} if len(rows) == limit else None}
        return self.dispatcher.run(lambda: self.dispatcher.transaction(action))
