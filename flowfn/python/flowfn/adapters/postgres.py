"""PostgreSQL persistence with transactional queue state and leased stream groups."""
import asyncio
import json
import time
import uuid
from typing import Any, Callable, Optional

import asyncpg  # type: ignore[import-untyped]

from flowfn.adapters.durable_queues import DurableQueues
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

    async def _database(self) -> Any:
        if self._closed:
            raise RuntimeError('PostgreSQL adapter is closed')
        async with self._initialize:
            if self._pool is None:
                pool = await asyncpg.create_pool(self.url, min_size=1, max_size=10)
                try:
                    async with pool.acquire() as connection:
                        installed = await connection.fetchval("SELECT to_regclass('flowfn_py_meta')")
                        version = await connection.fetchval('SELECT max(version) FROM flowfn_py_meta') if installed else None
                        if version not in (None,1):
                            raise RuntimeError("Unsupported FlowFn PostgreSQL schema version")
                        if version is None:
                            async with connection.transaction():
                                # Only first installation takes schema locks; opening
                                # a new worker must not run DDL against live workers.
                                await connection.execute("SELECT pg_advisory_xact_lock(490182735)")
                                await connection.execute(_SCHEMA)
                    self._pool = pool
                except BaseException:
                    await pool.close()
                    raise
        return self._pool

    async def _read_queue_state(self) -> Optional[str]:
        pool = await self._database()
        value: Optional[str] = await pool.fetchval('SELECT payload FROM flowfn_py_state WHERE namespace=$1', self.namespace)
        return value

    async def _transition(self, method: str, *args: Any) -> Any:
        pool = await self._database()
        async with pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute("INSERT INTO flowfn_py_state VALUES($1,'{}') ON CONFLICT DO NOTHING", self.namespace)
                raw = await connection.fetchval('SELECT payload FROM flowfn_py_state WHERE namespace=$1 FOR UPDATE', self.namespace)
                adapter = self._decode(raw)
                now = await connection.fetchval("SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint")
                result = await self._apply(adapter, method, args, now)
                await connection.execute('UPDATE flowfn_py_state SET payload=$2 WHERE namespace=$1', self.namespace, self._encode(adapter))
                return result

    async def save_workflow_state(self, execution_id: str, execution: WorkflowExecution) -> None:
        await self.transition_workflow_state(execution_id, "save", {"execution": execution})

    async def load_workflow_state(self, execution_id: str) -> Optional[WorkflowExecution]:
        pool = await self._database()
        raw = await pool.fetchval('SELECT payload FROM flowfn_py_workflows WHERE namespace=$1 AND id=$2', self.namespace, execution_id)
        return WorkflowExecution.model_validate_json(raw) if raw else None

    async def transition_workflow_state(self, execution_id: str, operation: str, payload: dict[str, Any]) -> Optional[WorkflowExecution]:
        from flowfn.adapters.workflow_state import transition
        pool = await self._database()
        async with pool.acquire() as connection:
            async with connection.transaction():
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
        pool = await self._database()
        async with pool.acquire() as connection:
            async with connection.transaction():
                await self._lock_stream(connection, stream)
                await connection.execute('INSERT INTO flowfn_py_events(namespace,stream,payload) VALUES($1,$2,$3)', self.namespace, stream, message.model_dump_json())
        return message.id

    async def get_stream_messages(self, stream: str) -> list[Message]:
        pool = await self._database()
        rows = await pool.fetch('SELECT payload FROM flowfn_py_events WHERE namespace=$1 AND stream=$2 ORDER BY id', self.namespace, stream)
        return [Message.model_validate_json(row['payload']) for row in rows]

    async def get_stream_info(self, stream: str) -> StreamInfo:
        pool = await self._database()
        row = await pool.fetchrow('SELECT (SELECT count(*) FROM flowfn_py_events WHERE namespace=$1 AND stream=$2) AS length, (SELECT count(*) FROM flowfn_py_groups WHERE namespace=$1 AND stream=$2) AS groups', self.namespace, stream)
        return StreamInfo(name=stream, length=row['length'], groups=row['groups'])

    async def trim_stream(self, stream: str, strategy: TrimStrategy) -> int:
        pool = await self._database()
        async with pool.acquire() as connection:
            async with connection.transaction():
                await self._lock_stream(connection, stream)
                # Group cursors and pending claims must remain stable while trimming.
                await connection.fetch('SELECT name FROM flowfn_py_groups WHERE namespace=$1 AND stream=$2 FOR UPDATE', self.namespace, stream)
                result = await connection.fetch('''
                    WITH ranked AS (
                      SELECT id, created_at, row_number() OVER(ORDER BY id DESC) AS position
                      FROM flowfn_py_events WHERE namespace=$1 AND stream=$2
                    ) DELETE FROM flowfn_py_events e USING ranked r
                    WHERE e.id=r.id AND (($3::bigint IS NOT NULL AND r.position>$3)
                        OR ($4::double precision IS NOT NULL AND r.created_at<clock_timestamp()-$4*interval '1 second'))
                    AND NOT EXISTS(SELECT 1 FROM flowfn_py_pending p WHERE p.event_id=e.id)
                    AND NOT EXISTS(SELECT 1 FROM flowfn_py_groups g WHERE g.namespace=$1 AND g.stream=$2 AND g.cursor<e.id)
                    RETURNING e.id
                ''', self.namespace, stream, strategy.max_length, strategy.max_age_seconds)
                return len(result)

    async def subscribe(self, stream: str, handler: Any) -> 'PostgresSubscription':
        pool = await self._database()
        cursor = await pool.fetchval('SELECT COALESCE(max(id),0) FROM flowfn_py_events WHERE namespace=$1 AND stream=$2', self.namespace, stream)
        subscription = PostgresSubscription(self, stream, handler, cursor=cursor)
        self._subscriptions.add(subscription)
        subscription.start()
        return subscription

    async def consume(self, stream: str, group: str, consumer: str, handler: Any,
                      options: Optional[ConsumerOptions] = None) -> 'PostgresSubscription':
        options = options or ConsumerOptions(group_id=group)
        pool = await self._database()
        async with pool.acquire() as connection:
            async with connection.transaction():
                await self._lock_stream(connection, stream)
                await connection.execute('''INSERT INTO flowfn_py_groups VALUES($1,$2,$3,
                    CASE WHEN $4 THEN 0 ELSE (SELECT COALESCE(max(id),0) FROM flowfn_py_events WHERE namespace=$1 AND stream=$2) END)
                    ON CONFLICT DO NOTHING''', self.namespace, stream, group, options.from_beginning)
        subscription = PostgresSubscription(self,stream,handler,group=group,consumer=consumer,options=options)
        self._subscriptions.add(subscription)
        subscription.start()
        return subscription

    async def cleanup(self) -> None:
        await asyncio.gather(*(sub.unsubscribe() for sub in list(self._subscriptions)))
        await self._close_queues()
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

    def start(self) -> None:
        self.tasks = [asyncio.create_task(self._worker()) for _ in range(self.options.max_in_flight if self.options else 1)]

    async def _next(self) -> Any:
        pool = await self.adapter._database()
        namespace = self.adapter.namespace
        if self.group is None:
            return await pool.fetchrow('SELECT id,payload FROM flowfn_py_events WHERE namespace=$1 AND stream=$2 AND id>$3 ORDER BY id LIMIT 1', namespace,self.stream,self.cursor)
        async with pool.acquire() as connection:
            async with connection.transaction():
                await self.adapter._lock_stream(connection, self.stream)
                cursor = await connection.fetchval('SELECT cursor FROM flowfn_py_groups WHERE namespace=$1 AND stream=$2 AND name=$3 FOR UPDATE', namespace,self.stream,self.group)
                pending = await connection.fetchval('SELECT event_id FROM flowfn_py_pending WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND expires_at<=clock_timestamp() ORDER BY event_id LIMIT 1 FOR UPDATE SKIP LOCKED', namespace,self.stream,self.group)
                if pending is not None:
                    await connection.execute("UPDATE flowfn_py_pending SET consumer=$4,expires_at=clock_timestamp()+$5*interval '1 millisecond' WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$6",namespace,self.stream,self.group,self.consumer,self.adapter.reclaim_after_ms,pending)
                    return await connection.fetchrow('SELECT id,payload FROM flowfn_py_events WHERE id=$1',pending)
                row = await connection.fetchrow('SELECT id,payload FROM flowfn_py_events WHERE namespace=$1 AND stream=$2 AND id>$3 ORDER BY id LIMIT 1', namespace,self.stream,cursor)
                if row is not None:
                    await connection.execute('UPDATE flowfn_py_groups SET cursor=$4 WHERE namespace=$1 AND stream=$2 AND name=$3',namespace,self.stream,self.group,row['id'])
                    await connection.execute("INSERT INTO flowfn_py_pending VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 millisecond')",namespace,self.stream,self.group,row['id'],self.consumer,self.adapter.reclaim_after_ms)
                return row

    async def _owned(self, identity: int, acknowledge: bool = False) -> bool:
        pool = await self.adapter._database()
        if acknowledge:
            result = await pool.execute('DELETE FROM flowfn_py_pending WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND consumer=$5', self.adapter.namespace,self.stream,self.group,identity,self.consumer)
        else:
            result = await pool.execute("UPDATE flowfn_py_pending SET expires_at=clock_timestamp()+$6*interval '1 millisecond' WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND consumer=$5", self.adapter.namespace,self.stream,self.group,identity,self.consumer,self.adapter.reclaim_after_ms)
        return bool(result != ('DELETE 0' if acknowledge else 'UPDATE 0'))

    async def _heartbeat(self, identity: int) -> None:
        while not self.closed:
            await asyncio.sleep(self.adapter.reclaim_after_ms / 3000)
            if not await self._owned(identity):
                return

    async def _worker(self) -> None:
        while not self.closed:
            await self.running.wait()
            try:
                row = await self._next()
                if row is None:
                    await asyncio.sleep(.02)
                    continue
                await self.running.wait()
                message = Message.model_validate_json(row['payload'])
                decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()

                async def settle(requeue: bool, target: asyncio.Future[bool] = decision, delivery_id: int = row['id']) -> None:
                    if not target.done():
                        if self.group and not requeue and not await self._owned(delivery_id, acknowledge=True):
                            raise RuntimeError('Stream delivery ownership changed')
                        target.set_result(requeue)

                message._acknowledge = settle
                heartbeat = asyncio.create_task(self._heartbeat(row['id'])) if self.group else None
                try:
                    try:
                        await self.handler(message)
                        if self.options is None or self.options.auto_commit:
                            await settle(False)
                        requeue = await decision
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        self.error = exc
                        requeue = True
                    if not self.group:
                        self.cursor = row['id']
                finally:
                    if heartbeat is not None:
                        heartbeat.cancel()
                        await asyncio.gather(heartbeat,return_exceptions=True)
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
