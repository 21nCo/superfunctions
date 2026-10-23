"""Explicit owned-loop dispatch. Ambiguous external outcomes are never retried."""
import asyncio
from copy import deepcopy
import json
import time
from uuid import uuid4
from superfunctions.db import AdapterError, DuplicateKeyError, CreateParams, FindOneParams, FindManyParams, OrderBy, WhereClause, UpdateManyParams
from .schema import ALERTS, OUTBOX, RUNTIME
from .durable import AlertConflict, encode, text
from .pagerduty import request as pagerduty_request, route_key

PROTOCOL = 'python-v1'


class _MarkerCollision(Exception):
    pass


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

    async def protocol(self, tx, *, existing_only=False):
        row = await tx.find_one(FindOneParams(model=RUNTIME, where=[WhereClause(field='id', value=self.manager.namespace)]))
        if row:
            if row.get('protocol') != PROTOCOL: raise RuntimeError('Alert namespace belongs to an incompatible dispatch protocol')
        else:
            if existing_only: raise RuntimeError('Alert namespace ownership could not be verified')
            if (await tx.find_one(FindOneParams(model=ALERTS, where=self.manager._where()))
                    or await tx.find_one(FindOneParams(model=OUTBOX, where=self.manager._where()))):
                raise RuntimeError('Existing alert rows require explicit namespace ownership migration')
            try:
                await tx.create(CreateParams(model=RUNTIME, data={'id': self.manager.namespace, 'protocol': PROTOCOL}))
            except DuplicateKeyError:
                # Only insertion of this immutable marker can converge below.
                # Let the failed transaction fully roll back before reading it.
                raise _MarkerCollision() from None

    async def transaction(self, action):
        async def run(tx, *, existing_only=False):
            if not callable(getattr(tx, 'update_many', None)): raise RuntimeError('Durable dispatch requires atomic transaction.update_many')
            await self.protocol(tx, existing_only=existing_only)
            return await action(tx)
        try:
            return await self.manager.storage.db.transaction(run)
        except _MarkerCollision:
            async def existing(tx):
                return await run(tx, existing_only=True)
            return await self.manager.storage.db.transaction(existing)

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

    async def _send(self, notification, channel, metadata=None):
        """Built-in HTTP clients only; no unbounded arbitrary sender callback."""
        if channel['type'] == 'email':
            from .email import send
            return await send(self.manager.delivery.email, notification, channel)
        import httpx
        payload = notification
        endpoint = channel.get('webhook')
        if channel['type'] == 'pagerduty':
            payload = pagerduty_request(self.manager.namespace, notification, channel, metadata)
            endpoint = self.manager.delivery.pagerduty_endpoint
        if channel['type'] == 'slack':
            # Incoming webhooks use the channel configured by Slack, not an override.
            alert = notification['alert']
            payload = {'text': f"[{alert.get('severity', 'warning')}] {alert['name']}: {notification['event']}"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout / 1000, follow_redirects=False, trust_env=False) as client:
                async with client.stream('POST', endpoint, json=payload, headers={'idempotency-key': notification['id'], 'content-type': 'application/json', 'accept-encoding': 'identity'}) as response:
                    if 200 <= response.status_code < 300:
                        if channel['type'] in ('slack', 'pagerduty'):
                            body = bytearray()
                            if response.headers.get('content-encoding', 'identity') != 'identity': return 'unknown'
                            async for part in response.aiter_raw():
                                body.extend(part)
                                if len(body) > (4096 if channel['type'] == 'pagerduty' else 1024): return 'unknown'
                            if channel['type'] == 'slack':
                                if response.status_code != 200 or bytes(body).strip() != b'ok': return 'unknown'
                            else:
                                receipt = json.loads(body)
                                if (response.status_code != 202 or not isinstance(receipt, dict)
                                        or receipt.get('status') != 'success' or receipt.get('dedup_key') != payload['dedup_key']):
                                    return 'unknown'
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
            if channel.get('type') not in ('slack', 'webhook', 'pagerduty', 'email'): return None
            if channel['type'] == 'email' and self.manager.delivery.email is None: return None
            if channel['type'] != 'email':
                try: import httpx  # noqa: F401
                except ImportError: raise RuntimeError('Install watchfn[dispatch] before HTTP notification dispatch') from None
            # Revalidate stored routing before any claim/request; credentials stay private.
            self.manager._definition({'name': 'dispatch', 'condition': {'metric': 'dispatch', 'window': '1m', 'operator': 'gt', 'threshold': 0}, 'channels': [channel]})
            if channel['type'] == 'email':
                from .email import recipients
                recipients(channel)
            if channel['type'] == 'pagerduty':
                metadata = value.get('pagerDuty')
                if (not isinstance(metadata, dict) or not text(metadata.get('episode'), 128)
                        or metadata.get('route') != route_key(channel)):
                    raise ValueError('PagerDuty job requires incident metadata migration')
                predecessor = metadata.get('predecessor')
                event = value['notification']['event']
                if predecessor is None:
                    if event != 'triggered' or metadata.get('predecessorEpisode') is not None:
                        raise ValueError('Missing PagerDuty predecessor')
                else:
                    if not text(predecessor, 128): raise ValueError('Invalid PagerDuty predecessor')
                    previous = await tx.find_one(FindOneParams(model=OUTBOX, where=self.manager._where(predecessor)))
                    if previous is None: raise ValueError('Missing retained PagerDuty predecessor receipt')
                    previous_value = self.payload(previous)
                    previous_metadata = previous_value.get('pagerDuty', {})
                    if (previous['alertId'] != row['alertId'] or previous_metadata.get('episode') != metadata.get('predecessorEpisode')
                            or previous_metadata.get('route') != metadata['route']
                            or (event == 'triggered' and (previous_value['notification']['event'] != 'resolved' or previous_metadata.get('episode') == metadata['episode']))
                            or (event != 'triggered' and previous_metadata.get('episode') != metadata['episode'])):
                        raise ValueError('Invalid PagerDuty predecessor ownership')
                    if previous_value.get('delivery', {}).get('outcome') != 'delivered': return None
            if row['attempts'] >= self.attempts:
                value['delivery'] = {'outcome': 'rejected', 'reason': 'retry-limit'}
                changed = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(identifier) + [WhereClause(field='revision', value=row['revision'])], data={'state': 'dead', 'leaseToken': None, 'revision': row['revision'] + 1, 'payload': encode(value)}))
                if changed != 1: raise AlertConflict('Concurrent notification update')
                return None
            token = str(uuid4())
            update = {'state': 'sending', 'leaseToken': token, 'revision': row['revision'] + 1, 'attempts': row['attempts'] + 1, 'availableAt': clock() + self.lease}
            changed = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(identifier) + [WhereClause(field='revision', value=row['revision'])], data=update))
            if changed == 0: return None  # Another worker owns this claim; no I/O occurred.
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
        metadata, sequence = value.get('pagerDuty'), record.get('pagerDuty')
        if (outcome == 'delivered' and metadata and sequence and sequence.get('tails', {}).get(metadata['route']) == row['id']):
            sequence['settled'] = list(set(sequence.get('settled', [])) | {metadata['route']})
        if outcome == 'delivered': record['lastNotification'] = {'event': value['notification']['event'], 'deliveredAt': clock()}
        changed = await tx.update_many(UpdateManyParams(model=ALERTS, where=self.manager._where(row['alertId']) + [WhereClause(field='revision', value=alert_row['revision'])], data={'revision': alert_row['revision'] + 1, 'state': record['state'], 'payload': encode(record)}))
        if changed != 1: raise AlertConflict('Concurrent alert delivery')
        delivery = {'outcome': outcome, 'completedAt': clock()}
        if actor is not None: delivery.update(actor=actor, reason=reason)
        # Keep a receipt for ambiguous local commits; remove routing credentials.
        payload = {'notification': value['notification'], 'delivery': delivery}
        if 'pagerDuty' in value: payload['pagerDuty'] = value['pagerDuty']
        changed = await tx.update_many(UpdateManyParams(model=OUTBOX, where=self.manager._where(row['id']) + [WhereClause(field='revision', value=row['revision'])], data={'state': 'dead', 'leaseToken': None, 'revision': row['revision'] + 1, 'payload': encode(payload)}))
        if changed != 1: raise AlertConflict('Concurrent notification reconciliation')
        return True

    def process(self):
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
                try: outcome = await asyncio.wait_for(self._send(deepcopy(payload['notification']), deepcopy(payload['channel']), deepcopy(payload.get('pagerDuty'))), self.timeout / 1000)
                except Exception as error:
                    from .email import EmailCleanupError
                    if isinstance(error, EmailCleanupError): raise
                    outcome = 'unknown'
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
