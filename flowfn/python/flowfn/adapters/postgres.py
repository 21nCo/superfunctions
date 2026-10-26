"""PostgreSQL persistence with transactional queue state and leased stream groups."""

import asyncio
import json
import time
import uuid
from collections.abc import Awaitable, Callable
from functools import partial
from typing import Any, Optional

import asyncpg  # type: ignore[import-untyped]

from flowfn.adapters.durable_queues import DurableQueues
from flowfn.adapters.postgres_partitions import SCHEMA_V2, PostgresPartitions
from flowfn.queue.dlq import DLQJob
from flowfn.queue.types import Job, JobStatus, QueueStats
from flowfn.stream.types import ConsumerOptions, Message, StreamInfo, TrimStrategy
from flowfn.workflow.types import WorkflowExecution

_SCHEMA = '''
CREATE TABLE IF NOT EXISTS flowfn_py_meta(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS flowfn_py_state(namespace TEXT PRIMARY KEY, payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS flowfn_py_workflows(namespace TEXT NOT NULL, id TEXT NOT NULL, payload JSONB NOT NULL, PRIMARY KEY(namespace,id));
CREATE TABLE IF NOT EXISTS flowfn_py_events(id BIGSERIAL PRIMARY KEY, namespace TEXT NOT NULL, stream TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), payload JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS flowfn_py_events_stream ON flowfn_py_events(namespace,stream,id);
CREATE TABLE IF NOT EXISTS flowfn_py_groups(namespace TEXT NOT NULL, stream TEXT NOT NULL, name TEXT NOT NULL, cursor BIGINT NOT NULL, PRIMARY KEY(namespace,stream,name));
CREATE TABLE IF NOT EXISTS flowfn_py_pending(namespace TEXT NOT NULL, stream TEXT NOT NULL, group_name TEXT NOT NULL, event_id BIGINT NOT NULL REFERENCES flowfn_py_events(id), consumer TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(namespace,stream,group_name,event_id));
INSERT INTO flowfn_py_meta(version) VALUES(1) ON CONFLICT DO NOTHING;
'''


class PostgresAdapter(DurableQueues):
    def __init__(self, url: str, *, namespace: str = 'flowfn', reclaim_after_ms: int = 30000,
                 backoff_strategies: Optional[dict[str, Callable[[int], int]]] = None) -> None:
        if not namespace or reclaim_after_ms < 100:
            raise ValueError('A namespace and reclaim_after_ms >= 100 are required')
        self.url = url
        self.namespace = namespace
        self._setup_queues(reclaim_after_ms, backoff_strategies)
        self._pool: Any = None
        self._initialize = asyncio.Lock()
        self._subscriptions: set[PostgresSubscription] = set()
        self._partitions = PostgresPartitions(self)
        self._draining = False
        self._cleanup_task: Optional[asyncio.Task[None]] = None

    async def _database(self, *, allow_draining: bool = False) -> Any:
        if self._closed or (self._draining and not allow_draining):
            raise RuntimeError('PostgreSQL adapter is closed')
        async with self._initialize:
            if self._closed or (self._draining and not allow_draining):
                raise RuntimeError('PostgreSQL adapter is closed')
            if self._draining and self._pool is None:
                raise RuntimeError('No owned PostgreSQL pool during shutdown')
            if self._pool is None:
                pool = await asyncpg.create_pool(self.url, min_size=1, max_size=10)
                try:
                    async with pool.acquire() as connection:
                        installed = await connection.fetchval("SELECT to_regclass('flowfn_py_meta')")
                        version = await connection.fetchval('SELECT max(version) FROM flowfn_py_meta') if installed else None
                        if version == 1:
                            raise RuntimeError("FlowFn PostgreSQL stream schema v1 requires explicit migrate_stream_schema with stopped writers")
                        if version not in (None,2):
                            raise RuntimeError("Unsupported FlowFn PostgreSQL schema version")
                        if version is None:
                            async with connection.transaction():
                                # Only first installation takes schema locks; opening
                                # a new worker must not run DDL against live workers.
                                await connection.execute("SELECT pg_advisory_xact_lock(490182735)")
                                # Recheck under the installation lock after another opener.
                                installed = await connection.fetchval("SELECT to_regclass('flowfn_py_meta')")
                                version = await connection.fetchval("SELECT max(version) FROM flowfn_py_meta") if installed else None
                                if version is None:
                                    await connection.execute(_SCHEMA)
                                    await connection.execute(SCHEMA_V2)
                                elif version != 2:
                                    raise RuntimeError("Explicit stream schema migration required")
                    self._pool = pool
                except BaseException:
                    await pool.close()
                    raise
        return self._pool

    async def migrate_stream_schema(self) -> None:
        """Upgrade v1 atomically with every old writer stopped; never repartition history."""
        if self._closed or self._draining or self._pool is not None:
            raise RuntimeError('Migration requires a fresh open adapter and stopped writers')
        async with self._initialize:
            if self._closed or self._draining or self._pool is not None:
                raise RuntimeError('Migration requires a fresh open adapter and stopped writers')
            pool = await asyncpg.create_pool(self.url, min_size=1, max_size=1)
            try:
                async with pool.acquire() as connection, connection.transaction():
                    await connection.execute('SELECT pg_advisory_xact_lock(490182735)')
                    exists = await connection.fetchval("SELECT to_regclass('flowfn_py_meta')")
                    version = await connection.fetchval('SELECT max(version) FROM flowfn_py_meta') if exists else None
                    if version == 2:
                        return
                    if version != 1:
                        raise RuntimeError('Expected FlowFn PostgreSQL schema v1 for migration')
                    await connection.execute(SCHEMA_V2)
            finally:
                await pool.close()

    async def configure_stream(self, stream: str, partitions: Optional[int] = None) -> Optional[int]:
        return await self._partitions.configure(stream, partitions)

    async def migrate_legacy_queues(self) -> None:
        """Migrate atomically after all old-layout workers have been stopped."""
        from flowfn.adapters.postgres_queues import ensure_native
        await ensure_native(self,migrate=True)

    async def _read_queue_state(self) -> Optional[str]:
        from flowfn.adapters.postgres_queues import read_snapshot
        return await read_snapshot(self)

    async def _transition(self, method: str, *args: Any) -> Any:
        from flowfn.adapters.postgres_queues import transition
        return await transition(self,method,args)

    async def get_all_jobs(self, queue: str) -> list[Job]:
        from flowfn.adapters.postgres_queues import get_jobs
        return await get_jobs(self,queue)

    async def get_jobs(self, queue: str, status: JobStatus) -> list[Job]:
        from flowfn.adapters.postgres_queues import get_jobs
        return await get_jobs(self,queue,status)

    async def get_queue_stats(self, queue: str) -> QueueStats:
        from flowfn.adapters.postgres_queues import get_stats
        result: QueueStats = await get_stats(self,queue)
        return result

    async def get_dead_letters(self) -> list[DLQJob]:
        from flowfn.adapters.postgres_queues import get_dead_letters
        return await get_dead_letters(self)

    async def save_workflow_state(self, execution_id: str, execution: WorkflowExecution) -> None:
        await self.transition_workflow_state(execution_id, "save", {"execution": execution})

    async def load_workflow_state(self, execution_id: str) -> Optional[WorkflowExecution]:
        pool = await self._database()
        raw = await pool.fetchval('SELECT payload FROM flowfn_py_workflows WHERE namespace=$1 AND id=$2', self.namespace, execution_id)
        return WorkflowExecution.model_validate_json(raw) if raw else None

    async def transition_workflow_state(self, execution_id: str, operation: str, payload: dict[str, Any]) -> Optional[WorkflowExecution]:
        from flowfn.adapters.workflow_state import transition
        pool = await self._database()
        async with pool.acquire() as connection, connection.transaction():
            await connection.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,1))",json.dumps([self.namespace,execution_id]))
            raw = await connection.fetchval('SELECT payload FROM flowfn_py_workflows WHERE namespace=$1 AND id=$2 FOR UPDATE',self.namespace,execution_id)
            current = WorkflowExecution.model_validate_json(raw) if raw else None
            now = await connection.fetchval("SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint")
            result = transition(current,operation,payload,now)
            if result is not None:
                await connection.execute('INSERT INTO flowfn_py_workflows VALUES($1,$2,$3) ON CONFLICT(namespace,id) DO UPDATE SET payload=EXCLUDED.payload',self.namespace,execution_id,result.model_dump_json())
            return result

    async def list_workflow_states(self, workflow_id: str) -> list[WorkflowExecution]:
        pool = await self._database()
        rows = await pool.fetch("SELECT payload FROM flowfn_py_workflows WHERE namespace=$1 AND payload->>'workflow_id'=$2", self.namespace,workflow_id)
        return [WorkflowExecution.model_validate_json(row['payload']) for row in rows]

    async def _lock_stream(self, connection: Any, stream: str) -> None:
        await connection.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", json.dumps([self.namespace,stream]))

    async def publish(self, stream: str, message: Message) -> str:
        return await self._partitions.publish(stream, message)

    async def get_stream_messages(self, stream: str) -> list[Message]:
        pool = await self._database()
        rows = await pool.fetch('SELECT payload FROM flowfn_py_events WHERE namespace=$1 AND stream=$2 ORDER BY id', self.namespace, stream)
        return [Message.model_validate_json(row['payload']) for row in rows]

    async def get_stream_info(self, stream: str) -> StreamInfo:
        pool = await self._database()
        count = await self._partitions.policy(pool, stream)
        row = await pool.fetchrow("""SELECT
            (SELECT count(*) FROM flowfn_py_events WHERE namespace=$1 AND stream=$2) AS length,
            (SELECT count(*) FROM flowfn_py_groups WHERE namespace=$1 AND stream=$2) AS groups,
            (SELECT COALESCE(sum((SELECT count(*) FROM flowfn_py_events e
                LEFT JOIN flowfn_py_partition_progress p ON p.namespace=e.namespace AND p.stream=e.stream AND p.group_name=g.name AND p.partition=CASE WHEN $3::integer IS NOT NULL THEN (e.payload->>'partition')::integer END
                WHERE e.namespace=g.namespace AND e.stream=g.stream AND e.id>COALESCE(p.cursor,g.cursor))
                +(SELECT count(*) FROM flowfn_py_pending pending WHERE pending.namespace=g.namespace AND pending.stream=g.stream AND pending.group_name=g.name)),0)
                FROM flowfn_py_groups g WHERE g.namespace=$1 AND g.stream=$2) AS lag""", self.namespace, stream, count)
        return StreamInfo(name=stream,length=row['length'],groups=row['groups'],lag=int(row['lag']),partitions=count)

    async def trim_stream(self, stream: str, strategy: TrimStrategy) -> int:
        pool = await self._database()
        async with pool.acquire() as connection, connection.transaction():
            await self._lock_stream(connection, stream)
            # Serialize payload removal with claims; FK-free partition barriers survive.
            await connection.fetch('SELECT name FROM flowfn_py_groups WHERE namespace=$1 AND stream=$2 FOR UPDATE', self.namespace, stream)
            result = await connection.fetch('''
                WITH ranked AS (
                  SELECT id, created_at, row_number() OVER(ORDER BY id DESC) AS position
                  FROM flowfn_py_events WHERE namespace=$1 AND stream=$2
                ) DELETE FROM flowfn_py_events e USING ranked r
                WHERE e.id=r.id AND (($3::bigint IS NOT NULL AND r.position>$3)
                    OR ($4::double precision IS NOT NULL AND r.created_at<clock_timestamp()-$4*interval '1 second'))
                RETURNING e.id
            ''', self.namespace, stream, strategy.max_length, strategy.max_age_seconds)
            return len(result)

    async def subscribe(self, stream: str, handler: Any) -> 'PostgresSubscription':
        pool = await self._database()
        cursor = await pool.fetchval('SELECT COALESCE(max(id),0) FROM flowfn_py_events WHERE namespace=$1 AND stream=$2', self.namespace, stream)
        if self._draining:
            raise RuntimeError('PostgreSQL adapter is closed')
        subscription = PostgresSubscription(self, stream, handler, cursor=cursor)
        self._subscriptions.add(subscription)
        subscription.start()
        return subscription

    async def consume(self, stream: str, group: str, consumer: str, handler: Any,
                      options: Optional[ConsumerOptions] = None) -> 'PostgresSubscription':
        options = options or ConsumerOptions(group_id=group)
        pool = await self._database()
        async with pool.acquire() as connection, connection.transaction():
            await self._lock_stream(connection, stream)
            await self._partitions.mark_legacy(connection, stream)
            count = await self._partitions.policy(connection, stream)
            await connection.execute('''INSERT INTO flowfn_py_groups VALUES($1,$2,$3,
                CASE WHEN $4 THEN 0 ELSE (SELECT COALESCE(max(id),0) FROM flowfn_py_events WHERE namespace=$1 AND stream=$2) END)
                ON CONFLICT DO NOTHING''', self.namespace, stream, group, options.from_beginning)
        if self._draining:
            raise RuntimeError('PostgreSQL adapter is closed')
        if count is not None:
            from flowfn.adapters.postgres_partition_subscription import (
                PostgresPartitionSubscription,
            )
            subscription: PostgresSubscription = PostgresPartitionSubscription(self,stream,handler,group=group,consumer=consumer,options=options)
        else:
            subscription = PostgresSubscription(self,stream,handler,group=group,consumer=consumer,options=options)
        self._subscriptions.add(subscription)
        subscription.start()
        return subscription

    async def health_probe(self) -> dict[str, Any]:
        pool = await self._database()
        now = await pool.fetchval("SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint")
        return {"type": "postgres", "connected": True, "server_time": int(now)}

    async def cleanup(self) -> None:
        if self._cleanup_task is None:
            self._draining = True
            self._cleanup_task = asyncio.create_task(self._finish_cleanup())
        try:
            await asyncio.shield(self._cleanup_task)
        except asyncio.CancelledError as cancelled:
            while not self._cleanup_task.done():
                try:
                    await asyncio.shield(self._cleanup_task)
                except asyncio.CancelledError:
                    continue
                except BaseException:
                    break
            if not self._cleanup_task.cancelled():
                failure = self._cleanup_task.exception()
                if failure is not None:
                    raise cancelled from failure
            raise

    async def _finish_cleanup(self) -> None:
        await asyncio.gather(*(sub.unsubscribe() for sub in list(self._subscriptions)))
        await self._close_queues()
        async with self._initialize:
            if self._pool is not None:
                await self._pool.close()
                self._pool = None


class PostgresSubscription:
    def __init__(self, adapter: PostgresAdapter, stream: str, handler: Any, *, cursor: int = 0,
                 group: Optional[str] = None, consumer: str = 'subscriber', options: Optional[ConsumerOptions] = None) -> None:
        self.adapter = adapter
        self.stream = stream
        self.handler = handler
        self.cursor = cursor
        self.group = group
        self.consumer = consumer + ':' + uuid.uuid4().hex
        self.options = options
        self.running = asyncio.Event()
        self.running.set()
        self.closed = False
        self.tasks: list[asyncio.Task[None]] = []
        self.error: Optional[Exception] = None
        self._claim_lock = asyncio.Lock()

    def start(self) -> None:
        self.tasks = [asyncio.create_task(self._worker()) for _ in range(self.options.max_in_flight if self.options else 1)]

    async def _next(self, delivery_owner: str) -> Any:
        pool = await self.adapter._database()
        namespace = self.adapter.namespace
        if self.group is None:
            return await pool.fetchrow('SELECT id,payload FROM flowfn_py_events WHERE namespace=$1 AND stream=$2 AND id>$3 ORDER BY id LIMIT 1', namespace,self.stream,self.cursor)
        async with pool.acquire() as connection, connection.transaction():
            await self.adapter._lock_stream(connection, self.stream)
            cursor = await connection.fetchval('SELECT cursor FROM flowfn_py_groups WHERE namespace=$1 AND stream=$2 AND name=$3 FOR UPDATE', namespace,self.stream,self.group)
            pending = await connection.fetchval('SELECT event_id FROM flowfn_py_pending WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND expires_at<=clock_timestamp() ORDER BY event_id LIMIT 1 FOR UPDATE SKIP LOCKED', namespace,self.stream,self.group)
            if pending is not None:
                await connection.execute("UPDATE flowfn_py_pending SET consumer=$4,expires_at=clock_timestamp()+$5*interval '1 millisecond' WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$6",namespace,self.stream,self.group,delivery_owner,self.adapter.reclaim_after_ms,pending)
                return await connection.fetchrow('SELECT id,payload FROM flowfn_py_events WHERE id=$1',pending)
            row = await connection.fetchrow('SELECT id,payload FROM flowfn_py_events WHERE namespace=$1 AND stream=$2 AND id>$3 ORDER BY id LIMIT 1', namespace,self.stream,cursor)
            if row is not None:
                await connection.execute('UPDATE flowfn_py_groups SET cursor=$4 WHERE namespace=$1 AND stream=$2 AND name=$3',namespace,self.stream,self.group,row['id'])
                await connection.execute("INSERT INTO flowfn_py_pending VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 millisecond')",namespace,self.stream,self.group,row['id'],delivery_owner,self.adapter.reclaim_after_ms)
            return row

    async def _owned(self, identity: int, delivery_owner: str, acknowledge: bool = False) -> bool:
        pool = await self.adapter._database()
        async with pool.acquire() as connection, connection.transaction():
            # Evaluate expiry only after taking the row lock: a blocked
            # renewal cannot revive a claim using a timestamp from before its wait.
            await connection.fetchval('SELECT event_id FROM flowfn_py_pending WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 FOR UPDATE',self.adapter.namespace,self.stream,self.group,identity)
            if acknowledge:
                result = await connection.execute('DELETE FROM flowfn_py_pending WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND consumer=$5 AND expires_at>clock_timestamp()', self.adapter.namespace,self.stream,self.group,identity,delivery_owner)
            else:
                result = await connection.execute("UPDATE flowfn_py_pending SET expires_at=clock_timestamp()+$6*interval '1 millisecond' WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND consumer=$5 AND expires_at>clock_timestamp()", self.adapter.namespace,self.stream,self.group,identity,delivery_owner,self.adapter.reclaim_after_ms)
        return bool(result != ('DELETE 0' if acknowledge else 'UPDATE 0'))

    async def _worker(self) -> None:
        while not self.closed:
            await self.running.wait()
            try:
                delivery_owner = self.consumer + ':' + uuid.uuid4().hex
                # One polling request per subscription leaves pool capacity for
                # acknowledgments and renewal while handlers still run concurrently.
                async with self._claim_lock:
                    claim_started = time.monotonic()
                    row = await self._next(delivery_owner)
                    if row is None:
                        await asyncio.sleep(.02)
                if row is None:
                    continue
                await self.running.wait()
                message = Message.model_validate_json(row['payload'])
                decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()

                async def settle(requeue: bool, target: asyncio.Future[bool] = decision, delivery_id: int = row['id'], token: str = delivery_owner) -> None:
                    if target.cancelled():
                        raise RuntimeError('Stream delivery ownership changed')
                    if not target.done():
                        if self.group and not requeue and not await self._owned(delivery_id, token, acknowledge=True):
                            raise RuntimeError('Stream delivery ownership changed')
                        if not target.done():
                            target.set_result(requeue)

                message._acknowledge = settle
                async def process(payload: Message = message, outcome: asyncio.Future[bool] = decision, acknowledge: Callable[[bool], Awaitable[None]] = settle) -> None:
                    await self.handler(payload)
                    if self.options is None or self.options.auto_commit:
                        await acknowledge(False)
                    await outcome

                try:
                    if self.group:
                        from flowfn.adapters.stream_lease import run_with_lease
                        await run_with_lease(process,partial(self._owned, row['id'], delivery_owner),
                                             self.adapter.reclaim_after_ms,claim_started)
                    else:
                        await process()
                        self.cursor = row['id']
                finally:
                    if not decision.done():
                        decision.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.error = exc
                await asyncio.sleep(.1)

    async def pause(self) -> None:
        self.running.clear()

    async def resume(self) -> None:
        self.running.set()

    async def unsubscribe(self) -> None:
        self.closed = True
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks,return_exceptions=True)
        self.adapter._subscriptions.discard(self)
