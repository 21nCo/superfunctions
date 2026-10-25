"""Serialized async adapter ownership with a synchronous batcher bridge."""
import asyncio
from concurrent.futures import wait
import json
import math
import threading
import time
from superfunctions.db import CreateParams, FindOneParams, FindManyParams, OrderBy, WhereClause, DeleteParams, UpdateParams
from ..models import Event
from .schema import get_watchfn_schema
from .log_index import get_log_index_schema, rows_for, coverage, equality_filter
from .events import decode_event, encode_event


def received_order(value):
    if value is None:
        return 0
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0 or value > 9007199254740991 or int(value) != value:
        raise ValueError("Invalid stored event order")
    return int(value)


class DatabaseStorage:
    SCAN_LIMIT = 10000
    SCAN_BYTES = 16 * 1024 * 1024

    def __init__(self, db, table_name="watchfn_events"):
        if not callable(getattr(db, "transaction", None)) or not getattr(getattr(db, "capabilities", None), "transactions", False):
            raise ValueError("WatchFn database storage requires transactions")
        self.schema = get_watchfn_schema(table_name)
        self.log_index_schema = get_log_index_schema(table_name)
        self.db, self.table_name = db, self.schema.name
        self._lifecycle = threading.Lock()
        self._close_lock = threading.Lock()
        self._thread = None
        self._loop = None
        self._closing = False
        self._pending = set()

    def start(self):
        with self._lifecycle:
            if self._closing:
                raise RuntimeError("Database storage is stopping")
            if self._thread is not None:
                return
            ready = threading.Event()
            def run():
                self._loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self._loop)
                self._serial = asyncio.Lock()
                ready.set()
                try:
                    self._loop.run_forever()
                finally:
                    self._loop.run_until_complete(self._loop.shutdown_asyncgens())
                    self._loop.close()
            self._thread = threading.Thread(target=run, name="watchfn-database", daemon=True)
            self._thread.start()
            ready.wait()

    def _submit(self, operation, *args):
        with self._lifecycle:
            if self._thread is None or self._closing:
                raise RuntimeError("Database storage is not running")
            if threading.current_thread() is self._thread:
                raise RuntimeError("Reentrant synchronous storage call")
            async def execute():
                async with self._serial:
                    return await operation(*args)
            future = asyncio.run_coroutine_threadsafe(execute(), self._loop)
            self._pending.add(future)
        def completed(value):
            with self._lifecycle:
                self._pending.discard(value)
        future.add_done_callback(completed)
        return future

    def close(self):
        if threading.current_thread() is self._thread:
            raise RuntimeError("Cannot stop storage from its adapter callback")
        with self._close_lock:
            self._close()

    def _close(self):
        with self._lifecycle:
            if self._thread is None:
                return
            if self._closing:
                raise RuntimeError("Database storage is already stopping")
            if threading.current_thread() is self._thread:
                raise RuntimeError("Cannot stop storage from its adapter callback")
            self._closing = True
            pending, thread, loop = list(self._pending), self._thread, self._loop
        try:
            wait(pending)  # Drain admitted writes; do not cancel an uncertain commit.
            loop.call_soon_threadsafe(loop.stop)
            thread.join()
        finally:
            with self._lifecycle:
                self._thread = self._loop = None
                self._closing = False

    def _freeze(self, event):
        if event._storage_payload is None:
            raw = encode_event(event)
            event._storage_payload = raw
            event._storage_index_fields = json.dumps(list(event._log_index_fields), separators=(",", ":")) if event._log_index_fields is not None else None
        return {"id": event._storage_id, "payload": event._storage_payload,
                "projectionVersion": 0, "receivedAt": int(time.time() * 1000),
                "logIndexFields": event._storage_index_fields}

    async def _write(self, rows):
        async def persist(transaction):
            for row in rows:
                previous = await transaction.find_one(FindOneParams(model=self.table_name, where=[WhereClause(field="id", value=row["id"])]))
                if previous is not None:
                    if previous.get("payload") != row["payload"] or previous.get("logIndexFields") != row["logIndexFields"]:
                        raise ValueError("Stored event identity conflicts")
                    continue
                await transaction.create(CreateParams(model=self.table_name, data=row))
                policy = coverage(row["logIndexFields"])
                if policy is not None:
                    for index in rows_for(row["id"], json.loads(row["payload"]), policy):
                        await transaction.create(CreateParams(model=self.log_index_schema.name, data=index))
        await self.db.transaction(persist)

    def add(self, event):
        self.add_batch([event])

    def add_batch(self, events):
        rows = [self._freeze(event) for event in events]
        if rows:
            self._submit(self._write, rows).result()

    async def add_batch_async(self, events):
        rows = [self._freeze(event) for event in events]
        if rows:
            # Caller cancellation must not cancel an admitted transaction halfway.
            pending = asyncio.wrap_future(self._submit(self._write, rows))
            pending.add_done_callback(lambda value: None if value.cancelled() else value.exception())
            await asyncio.shield(pending)

    async def _query(self, metric):
        async def scan(transaction):
            events, last_id, count, size = [], None, 0, 0
            while True:
                where = [WhereClause(field="id", operator="gt", value=last_id)] if last_id is not None else None
                rows = await transaction.find_many(FindManyParams(model=self.table_name, where=where, order_by=[OrderBy(field="id")], limit=100))
                if not rows:
                    break
                for row in rows:
                    count += 1
                    if count > self.SCAN_LIMIT:
                        raise ValueError("Query scan limit exceeded")
                    identifier, payload = row.get("id"), row.get("payload")
                    if not isinstance(identifier, str) or (last_id is not None and identifier <= last_id) or not isinstance(payload, str):
                        raise ValueError("Invalid stored event")
                    last_id = identifier
                    size += len(payload.encode("utf-8"))
                    if size > self.SCAN_BYTES or len(payload.encode("utf-8")) > 65536:
                        raise ValueError("Query payload limit exceeded")
                    event = decode_event(payload)
                    if metric is None or event.name == metric:
                        received = received_order(row.get("receivedAt"))
                        events.append((received, identifier, event))
                if len(rows) < 100:
                    break
            events.sort(key=lambda value: (value[0], value[1]))
            return [value[2] for value in events]
        return await self.db.transaction(scan)

    def run_operation(self, operation):
        """Admit an owned async operation; stop drains it along with database work."""
        return self._submit(operation).result()

    def run_transaction(self, callback):
        """Admit a Watch-owned shared-adapter transaction on the existing owner loop."""
        return self._submit(self.db.transaction, callback).result()

    def query(self, metric=None):
        return self._submit(self._query, metric).result()

    async def _query_logs(self, where):
        selected = equality_filter(where)
        if selected is None:
            return await self._query(None)
        field_name, (kind, value_key) = selected
        async def scan(transaction):
            matched, after = set(), None
            while True:
                conditions = [WhereClause(field='field', value=field_name),
                              WhereClause(field='valueType', value=kind),
                              WhereClause(field='valueKey', value=value_key)]
                if after is not None:
                    conditions.append(WhereClause(field='eventId', operator='gt', value=after))
                rows = await transaction.find_many(FindManyParams(model=self.log_index_schema.name,
                    where=conditions, select=['eventId'], order_by=[OrderBy(field='eventId')], limit=100))
                for row in rows:
                    identifier = row.get('eventId')
                    if not isinstance(identifier, str) or (after is not None and identifier <= after):
                        raise ValueError('Invalid log index ordering')
                    matched.add(identifier); after = identifier
                    if len(matched) > self.SCAN_LIMIT:
                        raise ValueError('Query scan limit exceeded')
                if len(rows) < 100:
                    break
            events, after, scanned, size, metadata_size = [], None, 0, 0, 0
            while True:
                conditions = [WhereClause(field='id', operator='gt', value=after)] if after is not None else None
                rows = await transaction.find_many(FindManyParams(model=self.table_name, where=conditions,
                    select=['id', 'receivedAt', 'logIndexFields'], order_by=[OrderBy(field='id')], limit=100))
                for metadata in rows:
                    metadata_size += len(json.dumps(metadata, ensure_ascii=False, allow_nan=False).encode('utf-8'))
                    if metadata_size > self.SCAN_BYTES:
                        raise ValueError('Query metadata limit exceeded')
                    scanned += 1
                    if scanned > self.SCAN_LIMIT:
                        raise ValueError('Query scan limit exceeded')
                    identifier = metadata.get('id')
                    if not isinstance(identifier, str) or (after is not None and identifier <= after):
                        raise ValueError('Invalid stored event order')
                    after = identifier
                    policy = coverage(metadata.get('logIndexFields'))
                    if policy is not None and field_name in policy and identifier not in matched:
                        continue
                    row = await transaction.find_one(FindOneParams(model=self.table_name,
                        where=[WhereClause(field='id', value=identifier)], select=['payload']))
                    if row is None or not isinstance(row.get('payload'), str):
                        raise ValueError('Stored event disappeared during query')
                    payload = row['payload']; length = len(payload.encode('utf-8')); size += length
                    if length > 65536 or size > self.SCAN_BYTES:
                        raise ValueError('Query payload limit exceeded')
                    event = decode_event(payload)
                    received = received_order(metadata.get('receivedAt'))
                    events.append((received, identifier, event))
                if len(rows) < 100:
                    break
            events.sort(key=lambda item: (item[0], item[1]))
            return [item[2] for item in events]
        return await self.db.transaction(scan)

    def query_logs(self, where):
        """Index equality candidates plus legacy/uncovered residual rows."""
        return self._submit(self._query_logs, where).result()

    def backfill_log_index(self, fields, after=None, limit=100):
        """Explicit bounded migration; hosts must stop all old/new event writers."""
        from ..integrations.logfn import LogIntegrationConfig
        policy = LogIntegrationConfig(indexFields=fields).index_fields
        if type(limit) is not int or not 1 <= limit <= 1000 or (after is not None and (not isinstance(after, str) or not after or len(after) > 512)):
            raise ValueError('Invalid log index migration page')
        async def migrate(transaction):
            conditions = [WhereClause(field='id', operator='gt', value=after)] if after is not None else None
            rows = await transaction.find_many(FindManyParams(model=self.table_name, where=conditions,
                order_by=[OrderBy(field='id')], limit=limit))
            indexed, size = 0, 0
            for row in rows:
                payload = row.get('payload')
                if not isinstance(payload, str) or len(payload.encode('utf-8')) > 65536:
                    raise ValueError('Invalid stored event')
                size += len(payload.encode('utf-8'))
                if size > self.SCAN_BYTES:
                    raise ValueError('Migration payload limit exceeded; use a smaller page')
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Invalid stored event')
                if value.get('type') != 'log':
                    continue
                decode_event(payload)  # Never certify coverage for an invalid log envelope.
                previous = await transaction.find_many(FindManyParams(model=self.log_index_schema.name,
                    where=[WhereClause(field='eventId', value=row['id'])], limit=33))
                if len(previous) > 32:
                    raise ValueError('Invalid existing log index size')
                for index in previous:
                    await transaction.delete(DeleteParams(model=self.log_index_schema.name,
                        where=[WhereClause(field='id', value=index['id']), WhereClause(field='eventId', value=row['id'])]))
                for index in rows_for(row['id'], value, policy):
                    await transaction.create(CreateParams(model=self.log_index_schema.name, data=index))
                await transaction.update(UpdateParams(model=self.table_name,
                    where=[WhereClause(field='id', value=row['id'])],
                    data={'logIndexFields': json.dumps(policy, separators=(',', ':'))}))
                indexed += 1
            return {'scanned': len(rows), 'indexed': indexed,
                    'nextCursor': rows[-1]['id'] if len(rows) == limit else None}
        return self.run_transaction(migrate)
