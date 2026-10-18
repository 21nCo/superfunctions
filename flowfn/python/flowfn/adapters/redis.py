"""Redis-backed queues, workflow snapshots and streams.

Queue transitions use optimistic transactions over indexed per-job records.
Dependency and DLQ transitions remain atomic across independent processes.
"""

import asyncio
import json
import time
import uuid
from dataclasses import asdict
from typing import Any, Optional, Awaitable, cast, Callable
from urllib.parse import quote

from redis.asyncio import Redis
from redis.exceptions import ResponseError, WatchError

from flowfn.adapters.durable_queues import DurableQueues
from flowfn.queue.dlq import DLQJob, DLQManager
from flowfn.queue.types import Job, JobOptions, JobStatus, QueueStats, BackoffType
from flowfn.stream.types import ConsumerOptions, Message, StreamInfo, TrimStrategy
from flowfn.workflow.types import WorkflowExecution


class RedisAdapter(DurableQueues):
    def __init__(self, url: str = 'redis://localhost:6379', *, namespace: str = 'flowfn',
                 reclaim_after_ms: int = 30000,
                 backoff_strategies: Optional[dict[str, Callable[[int], int]]] = None) -> None:
        if not namespace or reclaim_after_ms < 100:
            raise ValueError('A namespace and reclaim_after_ms >= 100 are required')
        self.client: Redis = Redis.from_url(url, decode_responses=True)
        self.namespace = namespace
        self.prefix = 'flowfn:' + quote(namespace, safe='')
        self.state_key = self.prefix + ':state'
        self._setup_queues(reclaim_after_ms, backoff_strategies)
        self._subscriptions: set[RedisSubscription] = set()

    def _stream(self, name: str) -> str:
        self._check_open()
        return self.prefix + ':stream:' + quote(name, safe='')

    def _check_open(self) -> None:
        if self._closed:
            raise RuntimeError("Redis adapter is closed")

    async def migrate_legacy_queues(self) -> None:
        """Migrate atomically after all old-layout workers have been stopped."""
        from flowfn.adapters.redis_queues import ensure_native
        await ensure_native(self,migrate=True)

    async def _read_queue_state(self) -> Optional[str]:
        from flowfn.adapters.redis_queues import read_snapshot
        return await read_snapshot(self)

    async def _transition(self, method: str, *args: Any) -> Any:
        from flowfn.adapters.redis_queues import transition
        return await transition(self,method,args)

    async def get_all_jobs(self, queue: str) -> list[Job]:
        from flowfn.adapters.redis_queues import get_jobs
        return await get_jobs(self,queue)

    async def get_jobs(self, queue: str, status: JobStatus) -> list[Job]:
        from flowfn.adapters.redis_queues import get_jobs
        return await get_jobs(self,queue,status)

    async def get_queue_stats(self, queue: str) -> QueueStats:
        from flowfn.adapters.redis_queues import get_stats
        result: QueueStats = await get_stats(self,queue)
        return result

    async def get_dead_letters(self) -> list[DLQJob]:
        from flowfn.adapters.redis_queues import get_dead_letters
        return await get_dead_letters(self)

    async def save_workflow_state(self, execution_id: str, execution: WorkflowExecution) -> None:
        self._check_open()
        await self.transition_workflow_state(execution_id, "save", {"execution": execution})

    async def load_workflow_state(self, execution_id: str) -> Optional[WorkflowExecution]:
        self._check_open()
        value = await self.client.get(self.prefix + ':workflow:' + quote(execution_id, safe=''))
        return WorkflowExecution.model_validate_json(value) if value else None

    async def transition_workflow_state(self, execution_id: str, operation: str, payload: dict[str, Any]) -> Optional[WorkflowExecution]:
        from flowfn.adapters.workflow_state import transition
        self._check_open()
        key = self.prefix + ':workflow:' + quote(execution_id, safe='')
        while True:
            async with self.client.pipeline(transaction=True) as pipe:
                try:
                    await pipe.watch(key)
                    raw = await pipe.get(key)
                    current = WorkflowExecution.model_validate_json(raw) if raw else None
                    seconds, micros = await pipe.time()
                    result = transition(current, operation, payload, seconds * 1000 + micros // 1000)
                    if result is None:
                        return None
                    pipe.multi()  # type: ignore[no-untyped-call]
                    pipe.set(key, result.model_dump_json())
                    await pipe.execute()
                    return result
                except WatchError:
                    await asyncio.sleep(0)

    async def list_workflow_states(self, workflow_id: str) -> list[WorkflowExecution]:
        self._check_open()
        executions = []
        seen: set[str] = set()
        async for key in self.client.scan_iter(match=self.prefix + ':workflow:*'):
            if key in seen:
                continue
            seen.add(key)
            raw = await self.client.get(key)
            if raw is not None:
                execution = WorkflowExecution.model_validate_json(raw)
                if execution.workflow_id == workflow_id:
                    executions.append(execution)
        return executions

    async def publish(self, stream: str, message: Message) -> str:
        await self.client.xadd(self._stream(stream), {'payload': message.model_dump_json()})
        return message.id

    async def get_stream_messages(self, stream: str) -> list[Message]:
        rows = await self.client.xrange(self._stream(stream))
        return [Message.model_validate_json(fields['payload']) for _, fields in rows]

    async def get_stream_info(self, stream: str) -> StreamInfo:
        key = self._stream(stream)
        try:
            info = await self.client.xinfo_stream(key)
            groups=await self.client.xinfo_groups(key)
            lag=sum(group['lag']+group['pending'] for group in groups) if all(isinstance(group.get('lag'),int) for group in groups) else None
            return StreamInfo(name=stream,length=info['length'],groups=info['groups'],lag=lag,consumers=sum(group['consumers'] for group in groups))
        except ResponseError as exc:
            if 'no such key' not in str(exc):
                raise
            return StreamInfo(name=stream,length=0,lag=0,consumers=0)

    async def trim_stream(self, stream: str, strategy: TrimStrategy) -> int:
        # Keep entries still unread or pending in any group. Redis XTRIM alone
        # deletes their payload, making subsequent delivery impossible.
        script = """
        local rows = redis.call('XRANGE', KEYS[1], '-', '+')
        local groups = redis.call('XINFO', 'GROUPS', KEYS[1])
        local removed = 0
        local clock = redis.call('TIME')
        local cutoff = tonumber(ARGV[2]) >= 0 and (tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)-tonumber(ARGV[2])*1000) or -1
        local function greater(a,b)
          local am,as = string.match(a, '(%d+)-(%d+)')
          local bm,bs = string.match(b, '(%d+)-(%d+)')
          return tonumber(am)>tonumber(bm) or (am==bm and tonumber(as)>tonumber(bs))
        end
        for i,row in ipairs(rows) do
          local id = row[1]
          local millis = tonumber(string.match(id, '(%d+)-'))
          local candidate = (tonumber(ARGV[1])>=0 and i<=#rows-tonumber(ARGV[1]))
                            or (cutoff>=0 and millis<cutoff)
          if candidate then
            local protected = false
            for _,group in ipairs(groups) do
              local name,last
              for j=1,#group,2 do
                if group[j]=='name' then name=group[j+1] end
                if group[j]=='last-delivered-id' then last=group[j+1] end
              end
              if greater(id,last) or #redis.call('XPENDING',KEYS[1],name,id,id,1)>0 then
                protected=true
                break
              end
            end
            if not protected then removed=removed+redis.call('XDEL',KEYS[1],id) end
          end
        end
        return removed
        """
        key = self._stream(stream)
        if not await self.client.exists(key):
            return 0
        age = strategy.max_age_seconds if strategy.max_age_seconds is not None else -1
        result: int = await cast(Awaitable[Any], self.client.eval(script, 1, key,
                                            str(strategy.max_length if strategy.max_length is not None else -1), str(age)))
        return result

    async def subscribe(self, stream: str, handler: Any) -> 'RedisSubscription':
        rows = await self.client.xrevrange(self._stream(stream), count=1)
        cursor = rows[0][0] if rows else '0-0'
        subscription = RedisSubscription(self, stream, handler, cursor=cursor)
        self._subscriptions.add(subscription)
        subscription.start()
        return subscription

    async def consume(self, stream: str, group: str, consumer: str, handler: Any,
                      options: Optional[ConsumerOptions] = None) -> 'RedisSubscription':
        options = options or ConsumerOptions(group_id=group)
        try:
            await self.client.xgroup_create(self._stream(stream), group,
                                            id='0-0' if options.from_beginning else '$', mkstream=True)
        except ResponseError as exc:
            if 'BUSYGROUP' not in str(exc):
                raise
        subscription = RedisSubscription(self, stream, handler, group=group,
                                         consumer=consumer, options=options)
        self._subscriptions.add(subscription)
        subscription.start()
        return subscription

    async def cleanup(self) -> None:
        self._closed = True
        await asyncio.gather(*(item.unsubscribe() for item in list(self._subscriptions)))
        await self._close_queues()
        await self.client.aclose()


class RedisSubscription:
    def __init__(self, adapter: RedisAdapter, stream: str, handler: Any, *,
                 cursor: str = '0-0', group: Optional[str] = None, consumer: Optional[str] = None,
                 options: Optional[ConsumerOptions] = None) -> None:
        self.adapter = adapter
        self.key = adapter._stream(stream)
        self.handler = handler
        self.cursor = cursor
        self.group = group
        self.consumer = (consumer or "consumer") + ":" + uuid.uuid4().hex
        self.options = options
        self.running = asyncio.Event()
        self.running.set()
        self.tasks: list[asyncio.Task[None]] = []
        self.closed = False
        self.error: Optional[Exception] = None
        self._claim_lock = asyncio.Lock()
        self._reclaim_cursor = '0-0'
        self._owners_key = self.key + ':owners:' + quote(group or '',safe='')

    def start(self) -> None:
        concurrency = self.options.max_in_flight if self.options else 1
        self.tasks = [asyncio.create_task(self._worker()) for _ in range(concurrency)]

    async def _next(self, delivery_owner: str) -> Any:
        if not self.group:
            batches = await self.adapter.client.xread({self.key: self.cursor}, count=1, block=100)
            return batches[0][1] if batches else []
        # Claim and record the attempt token atomically. Reusing a Redis consumer
        # name is safe because stale attempts cannot replace this token later.
        script = """
        local claimed=redis.call('XAUTOCLAIM',KEYS[1],ARGV[1],ARGV[2],ARGV[3],ARGV[5],'COUNT',1)
        local rows=claimed[2]
        if claimed[3] then
          for _,id in ipairs(claimed[3]) do redis.call('HDEL',KEYS[2],id) end
        end
        if #rows==0 then
          local batches=redis.call('XREADGROUP','GROUP',ARGV[1],ARGV[2],'COUNT',1,'STREAMS',KEYS[1],'>')
          if batches then rows=batches[1][2] end
        end
        for _,row in ipairs(rows) do redis.call('HSET',KEYS[2],row[1],ARGV[4]) end
        return {claimed[1],rows}
        """
        reply = await cast(Awaitable[Any], self.adapter.client.eval(script,2,self.key,self._owners_key,
                            self.group,self.consumer,str(self.adapter.reclaim_after_ms),delivery_owner,self._reclaim_cursor))
        self._reclaim_cursor = reply[0]
        return [(row[0],dict(zip(row[1][::2],row[1][1::2]))) for row in reply[1]]

    async def _worker(self) -> None:
        while not self.closed:
            await self.running.wait()
            try:
                delivery_owner = uuid.uuid4().hex
                async with self._claim_lock:
                    claim_started = time.monotonic()
                    rows = await self._next(delivery_owner)
                    if not rows:
                        await asyncio.sleep(.02)
                for identity, fields in rows:
                    await self.running.wait()
                    message = Message.model_validate_json(fields['payload'])
                    decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()

                    async def settle(requeue: bool, future: asyncio.Future[bool] = decision,
                                     delivery_id: str = identity, token: str = delivery_owner) -> None:
                        if future.cancelled():
                            raise RuntimeError('Stream delivery ownership changed')
                        if not future.done():
                            if self.group and not requeue and not await self._owned(delivery_id,token,acknowledge=True):
                                raise RuntimeError('Stream delivery ownership changed')
                            if not future.done():
                                future.set_result(requeue)

                    message._acknowledge = settle
                    async def process() -> None:
                        await self.handler(message)
                        if self.options is None or self.options.auto_commit:
                            await settle(False)
                        await decision

                    try:
                        if self.group:
                            from flowfn.adapters.stream_lease import run_with_lease
                            await run_with_lease(process,lambda: self._owned(identity,delivery_owner),
                                                 self.adapter.reclaim_after_ms,claim_started)
                        else:
                            await process()
                            self.cursor = identity
                    finally:
                        if not decision.done():
                            decision.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.error = exc
                await asyncio.sleep(.1)

    async def _owned(self, identity: str, delivery_owner: str, acknowledge: bool = False) -> bool:
        script = """
        local pending=redis.call('XPENDING',KEYS[1],ARGV[1],ARGV[3],ARGV[3],1)
        if #pending==0 or pending[1][2]~=ARGV[2] or pending[1][3]>=tonumber(ARGV[6])
           or redis.call('HGET',KEYS[2],ARGV[3])~=ARGV[5] then return 0 end
        if ARGV[4]=='ack' then
          redis.call('HDEL',KEYS[2],ARGV[3])
          return redis.call('XACK',KEYS[1],ARGV[1],ARGV[3])
        end
        redis.call('XCLAIM',KEYS[1],ARGV[1],ARGV[2],0,ARGV[3],'JUSTID')
        return 1
        """
        return bool(await cast(Awaitable[Any], self.adapter.client.eval(script,2,self.key,self._owners_key,
                            self.group or '',self.consumer,identity,'ack' if acknowledge else 'renew',
                            delivery_owner,str(self.adapter.reclaim_after_ms))))

    async def pause(self) -> None:
        self.running.clear()

    async def resume(self) -> None:
        self.running.set()

    async def unsubscribe(self) -> None:
        self.closed = True
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.adapter._subscriptions.discard(self)
