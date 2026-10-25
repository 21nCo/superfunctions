"""Redis per-job records and transactionally maintained queue indexes."""
import asyncio
import hashlib
import json
import uuid
from dataclasses import asdict
from typing import Any, Optional
from urllib.parse import quote

from redis.exceptions import WatchError

from flowfn.adapters.memory import MemoryAdapter
from flowfn.adapters.native_queues import QueueTransaction, apply_native
from flowfn.queue.dlq import DLQJob
from flowfn.queue.types import Job, JobLeaseError, JobOptions, JobStatus


class RedisQueueTransaction(QueueTransaction):
    def __init__(self, pipe: Any, prefix: str, queue: str, sequence: int, now: int, begin: bool = True):
        self.pipe,self.prefix,self.queue,self.sequence,self.now,self.begin = pipe,prefix,queue,sequence,now,begin
        self.base = prefix+':queue:'+quote(queue,safe='')
        self.positions: dict[str,int] = {}
        self.refresh: set[str] = set()

    def key(self, name: str) -> str:
        return self.base+':'+name

    async def select(self, kind: str, value: Any = None) -> list[Job]:
        if kind == 'id':
            identities = [value]
        elif kind == 'dedup':
            identities = list(await self.pipe.smembers(self.key('dedup:'+quote(value,safe=''))))
        elif kind == 'state':
            identities = await self.pipe.zrange(self.key('status:'+value.value),0,-1)
        elif kind == 'expired':
            identities = await self.pipe.zrangebyscore(self.key('leases'),'-inf',value)
        elif kind == 'ready':
            members = await self.pipe.zrange(self.key('ready'),0,0)
            due = await self.pipe.zrangebyscore(self.key('due'),'-inf',value)
            members += due
            self.refresh.update(member.split(':',1)[1] for member in due)
            identities = [member.split(':',1)[1] for member in members]
        elif kind == 'graph':
            identities = list(await self.pipe.smembers(self.key('children')))
            identities += await self.pipe.zrangebyscore(self.key('parents'),1,'+inf')
        else:
            raise ValueError(kind)
        if not identities:
            return []
        identities = list(dict.fromkeys(identities))
        raws = await self.pipe.hmget(self.key('jobs'),identities)
        scores = await self.pipe.zmscore(self.key('sequence'),identities)
        jobs = []
        for identity,raw,score in zip(identities,raws,scores):
            if raw is None:
                continue
            job = Job.model_validate_json(raw)
            self.positions[identity] = int(score)
            object.__setattr__(job,'_storage_sequence',int(score))
            jobs.append(job)
        return jobs

    async def outcomes(self) -> dict[tuple[str,str],JobStatus]:
        raw = await self.pipe.hgetall(self.key('outcomes'))
        return {(self.queue,key):JobStatus(value) for key,value in raw.items()}

    async def dead_letters(self, identity: str) -> dict[tuple[str,str],Any]:
        raw = await self.pipe.hget(self.key('dlq'),identity)
        if raw is None:
            return {}
        value=json.loads(raw)
        value['options']=JobOptions.model_validate(value['options'])
        return {(self.queue,identity):DLQJob(**value)}

    def indexes(self, job: Job, position: int, remove: bool) -> None:
        pipe = self.pipe
        member = str(position).zfill(20)+':'+job.id
        if remove:
            pipe.zrem(self.key('status:'+job.state.value),job.id)
            pipe.zrem(self.key('ready'),member)
            pipe.zrem(self.key('due'),member)
            pipe.zrem(self.key('leases'),job.id)
        else:
            pipe.zadd(self.key('status:'+job.state.value),{job.id:position})
            due = job.available_at if job.available_at is not None else job.timestamp+job.delay
            if job.state in (JobStatus.WAITING,JobStatus.DELAYED) and not job.opts.wait_for:
                if due <= self.now:
                    pipe.zadd(self.key('ready'),{member:job.opts.priority})
                else:
                    pipe.zadd(self.key('due'),{member:due})
            if job.state == JobStatus.ACTIVE:
                pipe.zadd(self.key('leases'),{job.id:job.lease_expires_at or 0})
        if job.state not in (JobStatus.COMPLETED,JobStatus.FAILED):
            if job.opts.deduplication_key is not None:
                key = self.key('dedup:'+quote(job.opts.deduplication_key,safe=''))
                if remove:
                    pipe.srem(key,job.id)
                else:
                    pipe.sadd(key,job.id)
            if job.opts.wait_for:
                if remove:
                    pipe.srem(self.key('children'),job.id)
                else:
                    pipe.sadd(self.key('children'),job.id)
                for parent in set(job.opts.wait_for):
                    pipe.zincrby(self.key('parents'),-1 if remove else 1,parent)

    async def apply(self, before: MemoryAdapter, after: MemoryAdapter) -> None:
        if self.begin:
            self.pipe.multi()
        old={j.id:j for j in before._queues[self.queue]}
        new={j.id:j for j in after._queues[self.queue]}
        for identity in old.keys()-new.keys():
            self.indexes(old[identity],self.positions[identity],True)
            self.pipe.hdel(self.key('jobs'),identity)
            self.pipe.zrem(self.key('sequence'),identity)
        for identity,job in new.items():
            if identity in old and identity not in self.refresh and old[identity].model_dump_json()==job.model_dump_json():
                continue
            position=self.positions.get(identity)
            if position is None:
                self.sequence+=1
                position=self.sequence
            if identity in old:
                self.indexes(old[identity],position,True)
            self.pipe.hset(self.key('jobs'),identity,job.model_dump_json())
            self.pipe.zadd(self.key('sequence'),{identity:position})
            self.indexes(job,position,False)
        self.pipe.zremrangebyscore(self.key('parents'),'-inf',0)
        for key in before._dependency_results.keys()-after._dependency_results.keys():
            self.pipe.hdel(self.key('outcomes'),key[1])
        for key,status in after._dependency_results.items():
            if before._dependency_results.get(key)!=status:
                self.pipe.hset(self.key('outcomes'),key[1],status.value)
        for key in before._dead_letters.keys()-after._dead_letters.keys():
            self.pipe.hdel(self.key('dlq'),key[1])
        for key,record in after._dead_letters.items():
            if before._dead_letters.get(key)!=record:
                value=asdict(record)
                value['options']=record.options.model_dump(mode='json')
                self.pipe.hset(self.key('dlq'),key[1],json.dumps(value,allow_nan=False))
        self.pipe.set(self.key('counter'),self.sequence)
        self.pipe.incr(self.key('version'))
        self.pipe.sadd(self.prefix+':queues',self.queue)


async def ensure_native(owner: Any, migrate: bool = False) -> None:
    owner._check_open()
    if getattr(owner,'_native_ready',False):
        return
    marker=owner.prefix+':queue-layout'
    while True:
        async with owner.client.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(marker,owner.state_key)
                version=await pipe.get(marker)
                if version is not None:
                    if version!='2':
                        raise RuntimeError('Unsupported native queue layout')
                    owner._native_ready=True
                    return
                legacy=owner._decode(await pipe.get(owner.state_key))
                populated=any(legacy._queues.values()) or legacy._dead_letters or legacy._dependency_results
                if populated and not migrate:
                    raise RuntimeError('Legacy queue snapshot found; stop old workers and call migrate_legacy_queues() before using native queues')
                seconds,micros=await pipe.time()
                pipe.multi()
                if populated:
                    queues=set(legacy._queues)|{k[0] for k in legacy._dead_letters}|{k[0] for k in legacy._dependency_results}
                    for queue in queues:
                        state=MemoryAdapter()
                        state._queues[queue]=legacy._queues[queue]
                        state._dead_letters={k:v for k,v in legacy._dead_letters.items() if k[0]==queue}
                        state._dependency_results={k:v for k,v in legacy._dependency_results.items() if k[0]==queue}
                        await RedisQueueTransaction(pipe,owner.prefix,queue,0,seconds*1000+micros//1000,False).apply(MemoryAdapter(),state)
                pipe.set(marker,'2')
                await pipe.execute()
                owner._native_ready=True
                return
            except WatchError:
                await asyncio.sleep(0)


async def transition(owner: Any, method: str, args: tuple[Any,...]) -> Any:
    await ensure_native(owner)
    queue=args[0].original_queue if method=='save_dead_letter' else args[0]
    base=owner.prefix+':queue:'+quote(queue,safe='')
    from flowfn.adapters.redis_queue_scripts import DEQUEUE, ENQUEUE, RENEW, UPDATE
    if not hasattr(owner,'_queue_scripts'):
        owner._queue_scripts={name:owner.client.register_script(source) for name,source in [('enqueue',ENQUEUE),('dequeue',DEQUEUE),('renew',RENEW),('update',UPDATE)]}
    if method=='enqueue' and not args[1].opts.wait_for:
        job=args[1]
        if job.opts.prevent_duplicates and job.opts.deduplication_key is None:
            raw=json.dumps([job.name,job.data],sort_keys=True,separators=(',',':'),allow_nan=False)
            job.opts.deduplication_key=hashlib.sha256(raw.encode()).hexdigest()
        dedup=quote(job.opts.deduplication_key,safe='') if job.opts.deduplication_key is not None else ''
        raw=await owner._queue_scripts['enqueue'](keys=[base,owner.prefix+':queues'],args=[job.model_dump_json(),queue,dedup,'1' if job.opts.deduplication_key is not None else '0',job._relative_delay_ms if job._relative_delay_ms is not None else -1])
        result=Job.model_validate_json(raw[0])
        result._enqueue_created = bool(raw[1])
        owner._restore_backoff(result)
        return result
    if method=='dequeue':
        reply=await owner._queue_scripts['dequeue'](keys=[base],args=[uuid.uuid4().hex,owner.reclaim_after_ms])
        if reply[0]=='empty':
            return None
        if reply[0]=='claimed':
            return Job.model_validate_json(reply[1])
    if method=='update_job' and not args[1].opts.wait_for:
        from flowfn.adapters.native_queues import failure_record
        reply=await owner._queue_scripts['update'](keys=[base],args=[args[1].model_dump_json(),owner.reclaim_after_ms,await failure_record(queue,args[1]),args[1]._relative_delay_ms if args[1]._relative_delay_ms is not None else -1])
        if reply==0:
            raise JobLeaseError('Job lease has expired or ownership changed')
        if reply==1:
            return None
    if method=='_renew_job':
        owned=await owner._queue_scripts['renew'](keys=[base],args=[args[1].id,args[1].lease_token,owner.reclaim_after_ms])
        if not owned:
            raise JobLeaseError('Job lease has expired or ownership changed')
        return None
    while True:
        async with owner.client.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(base+':version')
                counter=int(await pipe.get(base+':counter') or 0)
                seconds,micros=await pipe.time()
                now=seconds*1000+micros//1000
                result=await apply_native(owner,RedisQueueTransaction(pipe,owner.prefix,queue,counter,now),queue,method,args,now)
                await pipe.execute()
                return result
            except WatchError:
                await asyncio.sleep(0)


async def read_snapshot(owner: Any) -> Optional[str]:
    await ensure_native(owner)
    # Administrative enumeration is intentionally separate from hot claims.
    # WATCH retries if any enumerated queue changes during the read.
    while True:
        async with owner.client.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(owner.prefix+':queues')
                queues=await pipe.smembers(owner.prefix+':queues')
                bases={queue:owner.prefix+':queue:'+quote(queue,safe='') for queue in queues}
                if bases:
                    await pipe.watch(*(base+':version' for base in bases.values()))
                state=MemoryAdapter()
                for queue,base in bases.items():
                    identities=await pipe.zrange(base+':sequence',0,-1)
                    if identities:
                        raws=await pipe.hmget(base+':jobs',identities)
                        state._queues[queue]=[Job.model_validate_json(raw) for raw in raws if raw is not None]
                    for identity,status in (await pipe.hgetall(base+':outcomes')).items():
                        state._dependency_results[(queue,identity)]=JobStatus(status)
                    for identity,raw in (await pipe.hgetall(base+':dlq')).items():
                        value=json.loads(raw)
                        value['options']=JobOptions.model_validate(value['options'])
                        state._dead_letters[(queue,identity)]=DLQJob(**value)
                pipe.multi()
                await pipe.execute()
                result: str=owner._encode(state)
                return result
            except WatchError:
                await asyncio.sleep(0)


async def get_jobs(owner: Any, queue: str, status: Optional[JobStatus] = None) -> list[Job]:
    await ensure_native(owner)
    base=owner.prefix+':queue:'+quote(queue,safe='')
    while True:
        async with owner.client.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(base+':version')
                identities=await pipe.zrange(base+(':sequence' if status is None else ':status:'+status.value),0,-1)
                raws=await pipe.hmget(base+':jobs',identities) if identities else []
                pipe.multi()
                await pipe.execute()
                return [Job.model_validate_json(raw) for raw in raws if raw is not None]
            except WatchError:
                await asyncio.sleep(0)


async def get_stats(owner: Any, queue: str) -> Any:
    from flowfn.queue.types import QueueStats
    await ensure_native(owner)
    base=owner.prefix+':queue:'+quote(queue,safe='')
    async with owner.client.pipeline(transaction=True) as pipe:
        for status in JobStatus:
            pipe.zcard(base+':status:'+status.value)
        counts=await pipe.execute()
    return QueueStats(**{status.value:count for status,count in zip(JobStatus,counts)})


async def get_dead_letters(owner: Any) -> list[DLQJob]:
    await ensure_native(owner)
    result=[]
    for queue in await owner.client.smembers(owner.prefix+':queues'):
        raws=await owner.client.hvals(owner.prefix+':queue:'+quote(queue,safe='')+':dlq')
        for raw in raws:
            value=json.loads(raw)
            value['options']=JobOptions.model_validate(value['options'])
            result.append(DLQJob(**value))
    return result
