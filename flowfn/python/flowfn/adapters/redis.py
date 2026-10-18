"""Redis-backed queues, workflow snapshots and streams.

Queue transitions use optimistic transactions over a namespace snapshot. This
preserves dependency and DLQ atomicity across independent Python processes.
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

    async def _read_queue_state(self) -> Optional[str]:
        self._check_open()
        value: Optional[str] = await self.client.get(self.state_key)
        return value

    async def _transition(self, method: str, *args: Any) -> Any:
        if self._closed:
            raise RuntimeError('Redis adapter is closed')
        while True:
            async with self.client.pipeline(transaction=True) as pipe:
                try:
                    await pipe.watch(self.state_key)
                    adapter = self._decode(await pipe.get(self.state_key))
                    seconds, micros = await pipe.time()
                    result = await self._apply(adapter, method, args, seconds * 1000 + micros // 1000)
                    payload = self._encode(adapter)
                    pipe.multi()  # type: ignore[no-untyped-call]
                    pipe.set(self.state_key, payload)
                    await pipe.execute()
                    return result
                except WatchError:
                    await asyncio.sleep(0)

    async def save_workflow_state(self, execution_id: str, execution: WorkflowExecution) -> None:
        self._check_open()
        await self.client.set(self.prefix + ':workflow:' + quote(execution_id, safe=''), execution.model_dump_json())

    async def load_workflow_state(self, execution_id: str) -> Optional[WorkflowExecution]:
        self._check_open()
        value = await self.client.get(self.prefix + ':workflow:' + quote(execution_id, safe=''))
        return WorkflowExecution.model_validate_json(value) if value else None

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
            return StreamInfo(name=stream, length=info['length'], groups=info['groups'])
        except ResponseError as exc:
            if 'no such key' not in str(exc):
                raise
            return StreamInfo(name=stream, length=0)

    async def trim_stream(self, stream: str, strategy: TrimStrategy) -> int:
        # Keep entries still unread or pending in any group. Redis XTRIM alone
        # deletes their payload, making subsequent delivery impossible.
        script = """
        local rows = redis.call('XRANGE', KEYS[1], '-', '+')
        local groups = redis.call('XINFO', 'GROUPS', KEYS[1])
        local removed = 0
        local function greater(a,b)
          local am,as = string.match(a, '(%d+)-(%d+)')
          local bm,bs = string.match(b, '(%d+)-(%d+)')
          return tonumber(am)>tonumber(bm) or (am==bm and tonumber(as)>tonumber(bs))
        end
        for i,row in ipairs(rows) do
          local id = row[1]
          local millis = tonumber(string.match(id, '(%d+)-'))
          local candidate = (tonumber(ARGV[1])>=0 and i<=#rows-tonumber(ARGV[1]))
                            or (tonumber(ARGV[2])>=0 and millis<tonumber(ARGV[2]))
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
        cutoff = int(time.time()*1000) - strategy.max_age_seconds*1000 if strategy.max_age_seconds is not None else -1
        result: int = await cast(Awaitable[Any], self.client.eval(script, 1, key,
                                            str(strategy.max_length if strategy.max_length is not None else -1), str(cutoff)))
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

    def start(self) -> None:
        concurrency = self.options.max_in_flight if self.options else 1
        self.tasks = [asyncio.create_task(self._worker()) for _ in range(concurrency)]

    async def _worker(self) -> None:
        client = self.adapter.client
        while not self.closed:
            await self.running.wait()
            try:
                if self.group:
                    claimed = await client.xautoclaim(self.key, self.group, self.consumer,
                                                     self.adapter.reclaim_after_ms, count=1)
                    rows = claimed[1]
                    if not rows:
                        batches = await client.xreadgroup(self.group, self.consumer, {self.key: '>'}, count=1, block=100)
                        rows = batches[0][1] if batches else []
                else:
                    batches = await client.xread({self.key: self.cursor}, count=1, block=100)
                    rows = batches[0][1] if batches else []
                for identity, fields in rows:
                    await self.running.wait()
                    message = Message.model_validate_json(fields['payload'])
                    decision: asyncio.Future[bool] = asyncio.get_running_loop().create_future()

                    async def settle(requeue: bool, future: asyncio.Future[bool] = decision, delivery_id: str = identity) -> None:
                        if not future.done():
                            if self.group and not requeue and not await self._owned(delivery_id, acknowledge=True):
                                raise RuntimeError('Stream delivery ownership changed')
                            future.set_result(requeue)

                    message._acknowledge = settle
                    heartbeat = asyncio.create_task(self._heartbeat(identity)) if self.group else None
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
                    finally:
                        if heartbeat is not None:
                            heartbeat.cancel()
                            await asyncio.gather(heartbeat, return_exceptions=True)
                    if not self.group:
                        self.cursor = identity
                    if requeue:
                        await asyncio.sleep(.01)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.error = exc
                await asyncio.sleep(.1)

    async def _owned(self, identity: str, acknowledge: bool = False) -> bool:
        script = """
        local pending=redis.call('XPENDING',KEYS[1],ARGV[1],ARGV[3],ARGV[3],1)
        if #pending==0 or pending[1][2]~=ARGV[2] then return 0 end
        if ARGV[4]=='ack' then
          return redis.call('XACK',KEYS[1],ARGV[1],ARGV[3])
        end
        redis.call('XCLAIM',KEYS[1],ARGV[1],ARGV[2],0,ARGV[3],'JUSTID')
        return 1
        """
        return bool(await cast(Awaitable[Any], self.adapter.client.eval(script, 1, self.key, self.group or '',
                                                    self.consumer, identity, 'ack' if acknowledge else 'renew')))

    async def _heartbeat(self, identity: str) -> None:
        while not self.closed:
            await asyncio.sleep(self.adapter.reclaim_after_ms / 3000)
            if not await self._owned(identity):
                return

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
