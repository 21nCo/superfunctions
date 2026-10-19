"""PostgreSQL per-job queue persistence and transactional indexes."""
import json
import hashlib
import uuid
from typing import Any, Optional
from dataclasses import asdict

from flowfn.adapters.memory import MemoryAdapter
from flowfn.adapters.native_queues import QueueTransaction, apply_native
from flowfn.queue.types import Job, JobStatus, JobOptions, JobLeaseError
from flowfn.queue.dlq import DLQJob

_SCHEMA = '''
CREATE TABLE IF NOT EXISTS flowfn_py_queue_layout(namespace TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS flowfn_py_jobs(namespace TEXT NOT NULL, queue TEXT NOT NULL, id TEXT NOT NULL, sequence BIGSERIAL NOT NULL, state TEXT NOT NULL, priority INTEGER NOT NULL, due BIGINT NOT NULL, lease BIGINT, dedup TEXT, has_dependencies BOOLEAN NOT NULL, payload JSONB NOT NULL, PRIMARY KEY(namespace,queue,id));
CREATE INDEX IF NOT EXISTS flowfn_py_jobs_ready ON flowfn_py_jobs(namespace,queue,priority,sequence,due) WHERE state IN ('waiting','delayed');
CREATE INDEX IF NOT EXISTS flowfn_py_jobs_expired ON flowfn_py_jobs(namespace,queue,lease) WHERE state='active';
CREATE INDEX IF NOT EXISTS flowfn_py_jobs_status ON flowfn_py_jobs(namespace,queue,state,sequence);
CREATE INDEX IF NOT EXISTS flowfn_py_jobs_dedup ON flowfn_py_jobs(namespace,queue,dedup) WHERE state NOT IN ('completed','failed');
CREATE INDEX IF NOT EXISTS flowfn_py_jobs_graph ON flowfn_py_jobs(namespace,queue,sequence) WHERE has_dependencies AND state NOT IN ('completed','failed');
CREATE TABLE IF NOT EXISTS flowfn_py_job_edges(namespace TEXT NOT NULL, queue TEXT NOT NULL, child TEXT NOT NULL, parent TEXT NOT NULL, PRIMARY KEY(namespace,queue,child,parent));
CREATE INDEX IF NOT EXISTS flowfn_py_job_parents ON flowfn_py_job_edges(namespace,queue,parent);
CREATE TABLE IF NOT EXISTS flowfn_py_job_outcomes(namespace TEXT NOT NULL,queue TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(namespace,queue,id));
CREATE TABLE IF NOT EXISTS flowfn_py_dead_letters(namespace TEXT NOT NULL,queue TEXT NOT NULL,id TEXT NOT NULL,payload JSONB NOT NULL,PRIMARY KEY(namespace,queue,id));
'''


def decode_job(row: Any) -> Job:
    job = Job.model_validate_json(row['payload']) if isinstance(row['payload'],str) else Job.model_validate(row['payload'])
    object.__setattr__(job,'_storage_sequence',row['sequence'])
    return job


class PostgresQueueTransaction(QueueTransaction):
    def __init__(self, connection: Any, namespace: str, queue: str):
        self.connection, self.namespace, self.queue = connection, namespace, queue
        self._prepared: Optional[dict[str,Any]] = None

    async def prepare(self, method: str, args: tuple[Any,...], now: int) -> int:
        plan: dict[str,Any]={'graph':method not in ('_renew_job','save_dead_letter','delete_dead_letter'),'ready':method=='dequeue','include_state':False}
        if method in ('enqueue','update_job','_renew_job'):
            plan['id']=args[1].id
        if method=='enqueue' and args[1].opts.prevent_duplicates:
            plan['dedup']=args[1].opts.deduplication_key
        if method=='update_job':
            job=args[1]
            policy=job.opts.remove_on_complete if job.state==JobStatus.COMPLETED else job.opts.remove_on_fail if job.state==JobStatus.FAILED else False
            if type(policy) is int:
                plan.update(state=job.state.value,include_state=True)
        if method=='dequeue':
            plan['state']='failed'
        if method=='clean_jobs':
            plan.update(state=args[2].value,include_state=True)
        if method in ('retry_dead_letter','delete_dead_letter'):
            plan['dlq']=args[1]
            if method=='retry_dead_letter':
                plan['id']=args[1]
        if method=='save_dead_letter':
            plan['dlq']=args[0].id
        raw=await self.connection.fetchval(_PROJECTION,self.namespace,self.queue,json.dumps(plan),now)
        self._prepared=json.loads(raw)
        return int(self._prepared["_now"])

    async def select(self, kind: str, value: Any = None) -> list[Job]:
        assert self._prepared is not None
        return [decode_job(row) for row in self._prepared[kind]]

    async def outcomes(self) -> dict[tuple[str,str],JobStatus]:
        assert self._prepared is not None
        return {(self.queue,row['id']):JobStatus(row['state']) for row in self._prepared['outcomes']}

    async def dead_letters(self, identity: str) -> dict[tuple[str,str],Any]:
        assert self._prepared is not None
        if not self._prepared['dlq']:
            return {}
        value=self._prepared['dlq'][0]
        value['options']=JobOptions.model_validate(value['options'])
        return {(self.queue,identity):DLQJob(**value)}

    async def apply(self, before: MemoryAdapter, after: MemoryAdapter) -> None:
        old={job.id:job for job in before._queues[self.queue]}
        new={job.id:job for job in after._queues[self.queue]}
        delta: dict[str,Any]={
            'delete_jobs':list(old.keys()-new.keys()),
            'jobs':[job.model_dump(mode='json') for identity,job in new.items() if identity not in old or old[identity].model_dump_json()!=job.model_dump_json()],
            'delete_outcomes':[key[1] for key in before._dependency_results.keys()-after._dependency_results.keys()],
            'outcomes':[{'id':key[1],'state':status.value} for key,status in after._dependency_results.items() if before._dependency_results.get(key)!=status],
            'delete_dlq':[key[1] for key in before._dead_letters.keys()-after._dead_letters.keys()],
            'dlq':[],
        }
        for key,record in after._dead_letters.items():
            if before._dead_letters.get(key)!=record:
                value=asdict(record);value['options']=record.options.model_dump(mode='json')
                delta['dlq'].append(value)
        if any(delta.values()):
            await self.connection.execute('SELECT flowfn_py_apply_v2($1,$2,$3)',self.namespace,self.queue,json.dumps(delta,allow_nan=False))


async def ensure_native(owner: Any, migrate: bool = False) -> None:
    if getattr(owner,'_native_ready',False):
        return
    pool = await owner._database()
    async with pool.acquire() as connection:
        if not await connection.fetchval("SELECT to_regprocedure('flowfn_py_enqueue_v3(text,text,text,jsonb)')"):
            async with connection.transaction():
                await connection.execute('SELECT pg_advisory_xact_lock(490182736)')
                await connection.execute(_SCHEMA)
                from flowfn.adapters.postgres_queue_functions import SCHEMA
                await connection.execute(SCHEMA)
        async with connection.transaction():
            await connection.execute('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',owner.namespace)
            version = await connection.fetchval('SELECT version FROM flowfn_py_queue_layout WHERE namespace=$1',owner.namespace)
            if version is not None and version != 2:
                raise RuntimeError('Unsupported native queue layout')
            if version is None:
                raw = await connection.fetchval('SELECT payload FROM flowfn_py_state WHERE namespace=$1 FOR UPDATE',owner.namespace)
                legacy = owner._decode(raw)
                populated = any(legacy._queues.values()) or legacy._dead_letters or legacy._dependency_results
                if populated and not migrate:
                    raise RuntimeError('Legacy queue snapshot found; stop old workers and call migrate_legacy_queues() before using native queues')
                if populated:
                    queues = set(legacy._queues)|{key[0] for key in legacy._dead_letters}|{key[0] for key in legacy._dependency_results}
                    for queue in queues:
                        selected = MemoryAdapter()
                        selected._queues[queue] = legacy._queues[queue]
                        selected._dead_letters = {k:v for k,v in legacy._dead_letters.items() if k[0]==queue}
                        selected._dependency_results = {k:v for k,v in legacy._dependency_results.items() if k[0]==queue}
                        await PostgresQueueTransaction(connection,owner.namespace,queue).apply(MemoryAdapter(),selected)
                await connection.execute('INSERT INTO flowfn_py_queue_layout VALUES($1,2)',owner.namespace)
                # Preserve legacy snapshot as rollback evidence. Never read it
                # again after marker commit; old writers must remain stopped.
    owner._native_ready = True


async def transition(owner: Any, method: str, args: tuple[Any,...]) -> Any:
    await ensure_native(owner)
    queue = args[0].original_queue if method == 'save_dead_letter' else args[0]
    pool = await owner._database()
    lock=json.dumps([owner.namespace,queue])
    if method=='enqueue' and not args[1].opts.wait_for:
        job=args[1]
        if job.opts.prevent_duplicates and job.opts.deduplication_key is None:
            raw=json.dumps([job.name,job.data],sort_keys=True,separators=(',',':'),allow_nan=False)
            job.opts.deduplication_key=hashlib.sha256(raw.encode()).hexdigest()
        raw=await pool.fetchval('SELECT flowfn_py_enqueue_v3($1,$2,$3,$4)',owner.namespace,queue,lock,job.model_dump_json())
        receipt=json.loads(raw)
        result=Job.model_validate(receipt["job"])
        result._enqueue_created = bool(receipt["created"])
        owner._restore_backoff(result)
        return result
    if method=='dequeue':
        raw=await pool.fetchval('SELECT flowfn_py_dequeue_v2($1,$2,$3,$4,$5)',owner.namespace,queue,lock,uuid.uuid4().hex,owner.reclaim_after_ms)
        reply=json.loads(raw)
        if reply['kind']=='empty':
            return None
        if reply['kind']=='claimed':
            return Job.model_validate(reply['job'])
    if method=='update_job' and not args[1].opts.wait_for:
        from flowfn.adapters.native_queues import failure_record
        reply=await pool.fetchval('SELECT flowfn_py_update_v2($1,$2,$3,$4,$5,$6)',owner.namespace,queue,lock,args[1].model_dump_json(),owner.reclaim_after_ms,await failure_record(queue,args[1]))
        if reply==0:
            raise JobLeaseError('Job lease has expired or ownership changed')
        if reply==1:
            return None
    if method=='_renew_job':
        owned=await pool.fetchval('SELECT flowfn_py_renew_v2($1,$2,$3,$4,$5,$6)',owner.namespace,queue,lock,args[1].id,args[1].lease_token,owner.reclaim_after_ms)
        if not owned:
            raise JobLeaseError('Job lease has expired or ownership changed')
        return None
    async with pool.acquire() as connection:
        async with connection.transaction():
            now = await connection.fetchval('WITH barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended($1,2))) SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint FROM barrier',lock)
            return await apply_native(owner,PostgresQueueTransaction(connection,owner.namespace,queue),queue,method,args,now)


async def read_snapshot(owner: Any) -> Optional[str]:
    await ensure_native(owner)
    pool = await owner._database()
    state = MemoryAdapter()
    async with pool.acquire() as connection:
        async with connection.transaction(isolation='repeatable_read',readonly=True):
            for row in await connection.fetch('SELECT queue,payload FROM flowfn_py_jobs WHERE namespace=$1 ORDER BY sequence',owner.namespace):
                state._queues[row['queue']].append(Job.model_validate_json(row['payload']))
            for row in await connection.fetch('SELECT queue,id,state FROM flowfn_py_job_outcomes WHERE namespace=$1',owner.namespace):
                state._dependency_results[(row['queue'],row['id'])] = JobStatus(row['state'])
            for row in await connection.fetch('SELECT queue,id,payload FROM flowfn_py_dead_letters WHERE namespace=$1',owner.namespace):
                value=json.loads(row['payload']);value['options']=JobOptions.model_validate(value['options'])
                state._dead_letters[(row['queue'],row['id'])]=DLQJob(**value)
    result: str = owner._encode(state)
    return result


async def get_jobs(owner: Any, queue: str, status: Optional[JobStatus] = None) -> list[Job]:
    await ensure_native(owner)
    pool=await owner._database()
    if status is None:
        rows=await pool.fetch('SELECT payload FROM flowfn_py_jobs WHERE namespace=$1 AND queue=$2 ORDER BY sequence',owner.namespace,queue)
    else:
        rows=await pool.fetch('SELECT payload FROM flowfn_py_jobs WHERE namespace=$1 AND queue=$2 AND state=$3 ORDER BY sequence',owner.namespace,queue,status.value)
    return [Job.model_validate_json(row['payload']) for row in rows]


async def get_stats(owner: Any, queue: str) -> Any:
    from flowfn.queue.types import QueueStats
    await ensure_native(owner)
    pool=await owner._database()
    rows=await pool.fetch('SELECT state,count(*) AS count FROM flowfn_py_jobs WHERE namespace=$1 AND queue=$2 GROUP BY state',owner.namespace,queue)
    return QueueStats(**{row['state']:row['count'] for row in rows})


async def get_dead_letters(owner: Any) -> list[DLQJob]:
    await ensure_native(owner)
    pool=await owner._database()
    result=[]
    for row in await pool.fetch('SELECT payload FROM flowfn_py_dead_letters WHERE namespace=$1',owner.namespace):
        value=json.loads(row['payload']);value['options']=JobOptions.model_validate(value['options'])
        result.append(DLQJob(**value))
    return result


_PROJECTION = '''
WITH graph AS MATERIALIZED (
  SELECT j.payload,j.sequence FROM flowfn_py_jobs j WHERE namespace=$1 AND queue=$2 AND ($3::jsonb->>'graph')::boolean AND has_dependencies AND state NOT IN ('completed','failed')
  UNION
  SELECT j.payload,j.sequence FROM flowfn_py_job_edges e JOIN flowfn_py_jobs j ON j.namespace=e.namespace AND j.queue=e.queue AND j.id=e.parent WHERE e.namespace=$1 AND e.queue=$2 AND ($3::jsonb->>'graph')::boolean
), ready AS (
  SELECT payload,sequence FROM flowfn_py_jobs WHERE namespace=$1 AND queue=$2 AND ($3::jsonb->>'ready')::boolean AND state IN ('waiting','delayed') AND NOT has_dependencies AND due<=$4 ORDER BY priority,sequence LIMIT 1
)
 , projection AS MATERIALIZED (SELECT jsonb_build_object(
  'graph',(SELECT COALESCE(jsonb_agg(to_jsonb(g)),'[]'::jsonb) FROM graph g),
  'ready',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM ready r),
  'expired',(SELECT COALESCE(jsonb_agg(jsonb_build_object('payload',payload,'sequence',sequence)),'[]'::jsonb) FROM flowfn_py_jobs WHERE namespace=$1 AND queue=$2 AND ($3::jsonb->>'ready')::boolean AND state='active' AND lease<=$4),
  'id',(SELECT COALESCE(jsonb_agg(jsonb_build_object('payload',payload,'sequence',sequence)),'[]'::jsonb) FROM flowfn_py_jobs WHERE namespace=$1 AND queue=$2 AND id=$3::jsonb->>'id'),
  'dedup',(SELECT COALESCE(jsonb_agg(jsonb_build_object('payload',payload,'sequence',sequence)),'[]'::jsonb) FROM flowfn_py_jobs WHERE namespace=$1 AND queue=$2 AND dedup=$3::jsonb->>'dedup' AND state NOT IN ('completed','failed')),
  'state',(SELECT COALESCE(jsonb_agg(jsonb_build_object('payload',payload,'sequence',sequence)),'[]'::jsonb) FROM flowfn_py_jobs WHERE namespace=$1 AND queue=$2 AND state=$3::jsonb->>'state' AND (($3::jsonb->>'include_state')::boolean OR EXISTS(SELECT 1 FROM graph WHERE jsonb_typeof(payload->'opts'->'remove_on_fail')='number'))),
  'outcomes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'state',state)),'[]'::jsonb) FROM flowfn_py_job_outcomes WHERE namespace=$1 AND queue=$2 AND ($3::jsonb->>'graph')::boolean),
  'dlq',(SELECT COALESCE(jsonb_agg(payload),'[]'::jsonb) FROM flowfn_py_dead_letters WHERE namespace=$1 AND queue=$2 AND id=$3::jsonb->>'dlq')
) AS payload)
SELECT payload || jsonb_build_object('_now',(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint) FROM projection
'''
