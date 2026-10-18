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

from flowfn.adapters.memory import MemoryAdapter
from flowfn.queue.dlq import DLQJob, DLQManager
from flowfn.queue.types import Job, JobOptions, JobStatus, QueueStats, BackoffType
from flowfn.stream.types import ConsumerOptions, Message, StreamInfo, TrimStrategy
from flowfn.workflow.types import WorkflowExecution


class RedisAdapter:
    def __init__(self, url: str = 'redis://localhost:6379', *, namespace: str = 'flowfn',
                 reclaim_after_ms: int = 30000,
                 backoff_strategies: Optional[dict[str, Callable[[int], int]]] = None) -> None:
        if not namespace or reclaim_after_ms < 100:
            raise ValueError('A namespace and reclaim_after_ms >= 100 are required')
        self.client: Redis = Redis.from_url(url, decode_responses=True)
        self.prefix = 'flowfn:' + quote(namespace, safe='')
        self.state_key = self.prefix + ':state'
        self.backoff_strategies = dict(backoff_strategies or {})
        self.reclaim_after_ms = reclaim_after_ms
        self._subscriptions: set[RedisSubscription] = set()
        self._closed = False
        self._job_heartbeats: dict[tuple[str, str], asyncio.Task[None]] = {}

    def _stream(self, name: str) -> str:
        return self.prefix + ':stream:' + quote(name, safe='')

    @staticmethod
    def _decode(raw: Optional[str]) -> MemoryAdapter:
        adapter = MemoryAdapter()
        state = json.loads(raw) if raw else {}
        for name, jobs in state.get('queues', {}).items():
            adapter._queues[name] = [Job.model_validate(job) for job in jobs]
        for record in state.get('dead_letters', []):
            record['options'] = JobOptions.model_validate(record['options'])
            item = DLQJob(**record)
            adapter._dead_letters[(item.original_queue, item.id)] = item
        for queue, identity, status in state.get('dependencies', []):
            adapter._dependency_results[(queue, identity)] = JobStatus(status)
        return adapter

    @staticmethod
    def _encode(adapter: MemoryAdapter) -> str:
        dead_letters = []
        for record in adapter._dead_letters.values():
            value = asdict(record)
            value['options'] = record.options.model_dump(mode='json')
            dead_letters.append(value)
        return json.dumps({
            'queues': {name: [job.model_dump(mode='json') for job in jobs]
                       for name, jobs in adapter._queues.items()},
            'dead_letters': dead_letters,
            'dependencies': [[queue, identity, status.value]
                             for (queue, identity), status in adapter._dependency_results.items()],
        }, allow_nan=False)

    async def _transition(self, method: str, *args: Any) -> Any:
        if self._closed:
            raise RuntimeError('Redis adapter is closed')
        while True:
            async with self.client.pipeline(transaction=True) as pipe:
                try:
                    await pipe.watch(self.state_key)
                    adapter = self._decode(await pipe.get(self.state_key))
                    now = int(time.time() * 1000)
                    if method == 'dequeue':
                        for candidate in adapter._queues[args[0]]:
                            if candidate.state == JobStatus.ACTIVE and (candidate.lease_expires_at or 0) <= now:
                                candidate.state = JobStatus.WAITING
                                candidate.lease_token = None
                                candidate.lease_expires_at = None
                    if method in ('update_job', '_renew_job'):
                        queue, incoming = args
                        stored = next((entry for entry in adapter._queues[queue] if entry.id == incoming.id), None)
                        if stored is None or stored.state != JobStatus.ACTIVE or stored.lease_token != incoming.lease_token or (stored.lease_expires_at or 0) <= now:
                            raise ValueError('Job lease has expired or ownership changed')
                    if method == '_renew_job':
                        assert stored is not None
                        stored.lease_expires_at = now + self.reclaim_after_ms
                        result = None
                    else:
                        if method == 'update_job' and args[1].state == JobStatus.ACTIVE:
                            args[1].lease_expires_at = now + self.reclaim_after_ms
                        result = await getattr(adapter, method)(*args)
                        if method == 'update_job' and args[1].state == JobStatus.FAILED:
                            await DLQManager(adapter=adapter).move_to_dlq(args[1], args[1].failed_reason or 'Job failed', args[0])
                    if method == 'dequeue' and result is not None:
                        self._restore_backoff(result)
                        result.lease_token = uuid.uuid4().hex
                        result.lease_expires_at = now + self.reclaim_after_ms
                    payload = self._encode(adapter)
                    pipe.multi()  # type: ignore[no-untyped-call]
                    pipe.set(self.state_key, payload)
                    await pipe.execute()
                    return result
                except WatchError:
                    await asyncio.sleep(0)

    def _restore_backoff(self, job: Job) -> None:
        if job.opts.backoff and job.opts.backoff.type == BackoffType.CUSTOM:
            strategy = self.backoff_strategies.get(job.name)
            if strategy is None:
                raise ValueError(f'Configure backoff_strategies for job name: {job.name}')
            job.opts.backoff.strategy = strategy

    async def enqueue(self, queue: str, job: Job) -> Job:
        self._restore_backoff(job)
        result: Job = await self._transition('enqueue', queue, job.model_copy(deep=True))
        return result

    async def update_job(self, queue: str, job: Job) -> None:
        await self._transition('update_job', queue, job.model_copy(deep=True))
        if job.state != JobStatus.ACTIVE:
            heartbeat = self._job_heartbeats.pop((queue, job.id), None)
            if heartbeat is not None:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)

    async def dequeue(self, queue: str) -> Optional[Job]:
        result: Optional[Job] = await self._transition('dequeue', queue)
        if result is not None:
            key = (queue, result.id)
            previous = self._job_heartbeats.pop(key, None)
            if previous is not None:
                previous.cancel()
                await asyncio.gather(previous, return_exceptions=True)
            self._job_heartbeats[key] = asyncio.create_task(self._renew_job(queue, result.model_copy(deep=True)))
        return result

    async def _renew_job(self, queue: str, job: Job) -> None:
        while not self._closed:
            await asyncio.sleep(self.reclaim_after_ms / 3000)
            try:
                await self._transition('_renew_job', queue, job)
            except Exception:
                # Failure to renew allows takeover; stale completion is fenced.
                return

    async def get_queue_stats(self, queue: str) -> QueueStats:
        return await self._decode(await self.client.get(self.state_key)).get_queue_stats(queue)

    async def get_jobs(self, queue: str, status: JobStatus) -> list[Job]:
        return await self._decode(await self.client.get(self.state_key)).get_jobs(queue, status)

    async def get_all_jobs(self, queue: str) -> list[Job]:
        return await self._decode(await self.client.get(self.state_key)).get_all_jobs(queue)

    async def clean_jobs(self, queue: str, grace: int, status: JobStatus) -> int:
        result: int = await self._transition('clean_jobs', queue, grace, status)
        return result

    async def save_dead_letter(self, record: DLQJob) -> None:
        await self._transition('save_dead_letter', record)

    async def get_dead_letters(self) -> list[DLQJob]:
        return await self._decode(await self.client.get(self.state_key)).get_dead_letters()

    async def delete_dead_letter(self, queue: str, job_id: str) -> None:
        await self._transition('delete_dead_letter', queue, job_id)

    async def retry_dead_letter(self, queue: str, job_id: str) -> Job:
        result: Job = await self._transition('retry_dead_letter', queue, job_id)
        return result

    async def save_workflow_state(self, execution_id: str, execution: WorkflowExecution) -> None:
        await self.client.set(self.prefix + ':workflow:' + quote(execution_id, safe=''), execution.model_dump_json())

    async def load_workflow_state(self, execution_id: str) -> Optional[WorkflowExecution]:
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
        for task in self._job_heartbeats.values():
            task.cancel()
        await asyncio.gather(*self._job_heartbeats.values(), return_exceptions=True)
        self._job_heartbeats.clear()
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

                    async def settle(requeue: bool, future: asyncio.Future[bool] = decision) -> None:
                        if not future.done():
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
                        if self.group and not requeue:
                            await self._owned(identity, acknowledge=True)
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
