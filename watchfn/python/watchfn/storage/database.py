"""Serialized async adapter ownership with a synchronous batcher bridge."""
import asyncio
from concurrent.futures import wait
from datetime import timezone
import json
import threading
import time
from superfunctions.db import CreateParams, FindOneParams, FindManyParams, OrderBy, WhereClause
from ..models import Event
from .schema import get_watchfn_schema


class DatabaseStorage:
    SCAN_LIMIT = 10000
    SCAN_BYTES = 16 * 1024 * 1024

    def __init__(self, db, table_name="watchfn_events"):
        if not callable(getattr(db, "transaction", None)) or not getattr(getattr(db, "capabilities", None), "transactions", False):
            raise ValueError("WatchFn database storage requires transactions")
        self.schema = get_watchfn_schema(table_name)
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
            payload = event.model_dump(mode="json")
            stamp = event.timestamp
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            payload["timestamp"] = stamp.astimezone(timezone.utc).isoformat()
            raw = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            if len(raw.encode("utf-8")) > 65536:
                raise OverflowError("Event exceeds database payload limit")
            event._storage_payload = raw
        return {"id": event._storage_id, "payload": event._storage_payload,
                "projectionVersion": 0, "receivedAt": int(time.time() * 1000)}

    async def _write(self, rows):
        async def persist(transaction):
            for row in rows:
                previous = await transaction.find_one(FindOneParams(model=self.table_name, where=[WhereClause(field="id", value=row["id"])]))
                if previous is not None:
                    if previous.get("payload") != row["payload"]:
                        raise ValueError("Stored event identity conflicts")
                    continue
                await transaction.create(CreateParams(model=self.table_name, data=row))
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
                    value = json.loads(payload)
                    if (not isinstance(value, dict) or not {"type", "timestamp", "properties", "context"}.issubset(value)
                            or set(value) - {"type", "name", "properties", "timestamp", "context"}):
                        raise ValueError("Unsupported stored event shape")
                    event = Event.model_validate_json(payload, strict=True)
                    if metric is None or event.name == metric:
                        received = row.get("receivedAt")
                        if received is not None and (type(received) is not int or received < 0):
                            raise ValueError("Invalid stored event order")
                        events.append((received or 0, identifier, event))
                if len(rows) < 100:
                    break
            events.sort(key=lambda value: (value[0], value[1]))
            return [value[2] for value in events]
        return await self.db.transaction(scan)

    def query(self, metric=None):
        return self._submit(self._query, metric).result()
