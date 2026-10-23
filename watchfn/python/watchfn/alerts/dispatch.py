"""Explicit owned-loop dispatch. Ambiguous external outcomes are never retried."""
import asyncio
from copy import deepcopy
import json
import time
from uuid import uuid4
from superfunctions.db import AdapterError, CreateParams, FindOneParams, FindManyParams, OrderBy, WhereClause, UpdateManyParams
from .schema import ALERTS, OUTBOX, RUNTIME
from .durable import AlertConflict, encode, text

PROTOCOL = 'python-v1'


def clock():
    return int(time.time() * 1000)


class Dispatcher:
    def __init__(self, manager, *, limit=50, timeout_ms=10000, lease_ms=30000, max_attempts=5, after=None):
        manager._limit(limit)
        if after is not None and not text(after, 128): raise ValueError('Invalid notification cursor')
        self.after = after
        if (type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000 or type(lease_ms) is not int
                or not timeout_ms + 100 <= lease_ms <= 300000 or type(max_attempts) is not int or not 1 <= max_attempts <= 100):
            raise ValueError('Invalid dispatch timeout/lease/retry bounds')
        self.manager, self.limit, self.timeout, self.lease, self.attempts = manager, limit, timeout_ms, lease_ms, max_attempts

    async def protocol(self, tx):
        row = await tx.find_one(FindOneParams(model=RUNTIME, where=[WhereClause(field='id', value=self.manager.namespace)]))
        if row:
            if row.get('protocol') != PROTOCOL: raise RuntimeError('Alert namespace belongs to an incompatible dispatch protocol')
        else:
            await tx.create(CreateParams(model=RUNTIME, data={'id': self.manager.namespace, 'protocol': PROTOCOL}))

    async def transaction(self, action):
        async def run(tx):
            if not callable(getattr(tx, 'update_many', None)): raise RuntimeError('Durable dispatch requires atomic transaction.update_many')
            await self.protocol(tx)
            return await action(tx)
        return await self.manager.storage.db.transaction(run)

    def run(self, operation):
        if not self.manager.active(): raise RuntimeError('WatchFn storage is unavailable')
        try: return self.manager.storage.run_operation(operation)
        except AdapterError: raise RuntimeError('Alert storage operation failed') from None

    def payload(self, row):
        raw = row.get('payload')
        if not isinstance(raw, str) or len(raw.encode('utf-8')) > 524288: raise ValueError('Invalid notification payload')
        value = json.loads(raw)
        if (not isinstance(value, dict) or not isinstance(value.get('notification'), dict)
                or value['notification'].get('id') != row.get('id') or not isinstance(value['notification'].get('alert'), dict)
                or value['notification']['alert'].get('id') != row.get('alertId')
                or value['notification'].get('event') not in ('triggered', 'acknowledged', 'resolved')
                or type(row.get('revision')) is not int or not 0 <= row['revision'] < 9007199254740991
                or type(row.get('attempts')) is not int or not 0 <= row['attempts'] <= 100):
            raise ValueError('Invalid notification payload')
        return value

    async def _send(self, notification, channel):
        """Built-in HTTP clients only; no unbounded arbitrary sender callback."""
        import httpx
        payload = notification
        if channel['type'] == 'slack':
            # Incoming webhooks use the channel configured by Slack, not an override.
            alert = notification['alert']
            payload = {'text': f"[{alert.get('severity', 'warning')}] {alert['name']}: {notification['event']}"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout / 1000, follow_redirects=False, trust_env=False) as client:
                async with client.stream('POST', channel['webhook'], json=payload, headers={'idempotency-key': notification['id'], 'content-type': 'application/json', 'accept-encoding': 'identity'}) as response:
                    if 200 <= response.status_code < 300:
                        if channel['type'] == 'slack':
                            body = bytearray()
                            if response.headers.get('content-encoding', 'identity') != 'identity': return 'unknown'
                            async for part in response.aiter_raw():
                                body.extend(part)
                                if len(body) > 1024: return 'unknown'
                            if response.status_code != 200 or bytes(body).strip() != b'ok': return 'unknown'
                        return 'delivered'
                    if response.status_code == 429 and channel['type'] == 'slack':
                        delay = response.headers.get('retry-after', '')
                        if not delay.isascii() or not delay.isdecimal() or len(delay) > 5 or int(delay) > 86400:
                            return 'rejected'
                        return ('retryable', int(delay) * 1000)
                    if response.status_code in (400, 401, 403, 404, 410, 422): return 'rejected'
                    return 'unknown'
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout): return 'retryable'
        except Exception: return 'unknown'

    async def _claim(self, identifier):
        async def action(tx):
            row = await tx.find_one(FindOneParams(model=OUTBOX, where=self.manager._where(identifier)))
            if not row or row['state'] not in ('pending', 'sending') or row['availableAt'] > clock(): return None
            value = self.payload(row)
            if row['state'] == 'sending':
                value['delivery'] = {'outcome': 'unknown', 'reason': 'expired-lease'}
                changed = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(identifier) + [WhereClause(field='revision', value=row['revision'])], data={'state': 'dead', 'leaseToken': None, 'revision': row['revision'] + 1, 'payload': encode(value)}))
                if changed != 1: raise AlertConflict('Concurrent notification update')
                return None
            channel = value.get('channel')
            if not isinstance(channel, dict): raise ValueError('Missing pending notification channel')
            if channel.get('type') not in ('slack', 'webhook'): return None
            # Revalidate stored routing before any claim/request; credentials stay private.
            self.manager._definition({'name': 'dispatch', 'condition': {'metric': 'dispatch', 'window': '1m', 'operator': 'gt', 'threshold': 0}, 'channels': [channel]})
            if row['attempts'] >= self.attempts:
                value['delivery'] = {'outcome': 'rejected', 'reason': 'retry-limit'}
                changed = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(identifier) + [WhereClause(field='revision', value=row['revision'])], data={'state': 'dead', 'leaseToken': None, 'revision': row['revision'] + 1, 'payload': encode(value)}))
                if changed != 1: raise AlertConflict('Concurrent notification update')
                return None
            token = str(uuid4())
            update = {'state': 'sending', 'leaseToken': token, 'revision': row['revision'] + 1, 'attempts': row['attempts'] + 1, 'availableAt': clock() + self.lease}
            changed = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(identifier) + [WhereClause(field='revision', value=row['revision'])], data=update))
            if changed != 1: raise AlertConflict('Concurrent notification claim')
            return dict(row, **update), value
        return await self.transaction(action)

    async def _settle(self, claimed, outcome):
        retry_after = 0
        if isinstance(outcome, tuple): outcome, retry_after = outcome
        async def action(tx):
            row = await tx.find_one(FindOneParams(model=OUTBOX, where=self.manager._where(claimed['id'])))
            if (not row or row['state'] != 'sending' or row.get('leaseToken') != claimed['leaseToken']
                    or row['revision'] != claimed['revision'] or row['availableAt'] <= clock()): return False
            value = self.payload(row)
            if outcome == 'delivered':
                return await self._receipt(tx, row, value, 'delivered')
            retry = outcome == 'retryable' and row['attempts'] < self.attempts
            value['delivery'] = {'outcome': 'pending' if retry else 'rejected' if outcome == 'retryable' else outcome,
                                 'reason': 'safe-retry' if retry else 'retry-limit' if outcome == 'retryable' else 'provider-outcome'}
            count = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(row['id']) + [WhereClause(field='revision', value=row['revision']), WhereClause(field='leaseToken', value=row['leaseToken'])], data={'state': 'pending' if retry else 'dead', 'leaseToken': None, 'revision': row['revision'] + 1, 'availableAt': clock() + max(retry_after, min(60000, 1000 * 2 ** min(row['attempts'] - 1, 6))), 'payload': encode(value)}))
            if count != 1: raise AlertConflict('Concurrent notification completion')
            return True
        return await self.transaction(action)

    async def _receipt(self, tx, row, value, outcome, actor=None, reason=None):
        alert_row = await self.manager._row(tx, row['alertId'])
        record = self.manager._decode(alert_row)
        if record['pendingNotifications'] < 1 or alert_row['revision'] >= 9007199254740991: raise AlertConflict('Invalid notification accounting')
        record['pendingNotifications'] -= 1
        if outcome == 'delivered': record['lastNotification'] = {'event': value['notification']['event'], 'deliveredAt': clock()}
        changed = await tx.update_many(UpdateManyParams(model=ALERTS, where=self.manager._where(row['alertId']) + [WhereClause(field='revision', value=alert_row['revision'])], data={'revision': alert_row['revision'] + 1, 'state': record['state'], 'payload': encode(record)}))
        if changed != 1: raise AlertConflict('Concurrent alert delivery')
        delivery = {'outcome': outcome, 'completedAt': clock()}
        if actor is not None: delivery.update(actor=actor, reason=reason)
        # Keep a receipt for ambiguous local commits; remove routing credentials.
        payload = {'notification': value['notification'], 'delivery': delivery}
        changed = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(row['id']) + [WhereClause(field='revision', value=row['revision'])], data={'state': 'dead', 'leaseToken': None, 'revision': row['revision'] + 1, 'payload': encode(payload)}))
        if changed != 1: raise AlertConflict('Concurrent notification reconciliation')
        return True

    def process(self):
        try: import httpx  # noqa: F401
        except ImportError: raise RuntimeError('Install watchfn[dispatch] before notification dispatch') from None
        async def operation():
            async def select(tx):
                return await tx.find_many(FindManyParams(model=OUTBOX, where=self.manager._where() + [WhereClause(field='state', operator='in', value=['pending', 'sending']), WhereClause(field='availableAt', operator='lte', value=clock())] + ([WhereClause(field='id', operator='gt', value=self.after)] if self.after else []), order_by=[OrderBy(field='id')], limit=self.limit))
            rows = await self.transaction(select)
            processed = 0
            for row in rows:
                if not self.manager.active(): break
                claimed = await self._claim(row['id'])
                if claimed is None: continue
                job, payload = claimed
                # Stop after a claim but before I/O leaves a lease to be parked,
                # never a second worker's permission to replay uncertain work.
                if not self.manager.active(): break
                processed += 1
                try: outcome = await asyncio.wait_for(self._send(deepcopy(payload['notification']), deepcopy(payload['channel'])), self.timeout / 1000)
                except Exception: outcome = 'unknown'
                await self._settle(job, outcome)
            return {'processed': processed, 'nextCursor': rows[-1]['id'] if len(rows) == self.limit else None}
        return self.run(operation)

    def reconcile(self, identifier, outcome, actor, reason):
        if not text(identifier, 128) or outcome not in ('delivered', 'dismissed') or not text(actor, 255) or not text(reason, 4096):
            raise ValueError('Reconciliation requires a valid ID, outcome, actor and reason')
        async def operation():
            async def action(tx):
                row = await tx.find_one(FindOneParams(model=OUTBOX, where=self.manager._where(identifier)))
                if row is None: return False
                value = self.payload(row)
                current = value.get('delivery', {}).get('outcome')
                if current in ('delivered', 'dismissed'): return False
                if row['state'] != 'dead' or current not in ('unknown', 'rejected'):
                    raise ValueError('Only parked notifications can be reconciled')
                return await self._receipt(tx, row, value, outcome, actor, reason)
            return await self.transaction(action)
        return self.run(operation)
