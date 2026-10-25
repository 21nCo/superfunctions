"""Run only against disposable Redis/PostgreSQL URLs from FLOWFN_*_URL.

Seeds retained history through the public legacy migration boundary, measures
sequential API latencies, and measures same-queue concurrent enqueue and
claim-and-complete throughput.
Every run owns a fresh namespace and deletes all of its records in finally.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import time
import uuid

from flowfn.adapters.memory import MemoryAdapter
from flowfn.adapters.postgres import PostgresAdapter
from flowfn.adapters.redis import RedisAdapter
from flowfn.queue.types import Job, JobOptions, JobStatus


def metrics(samples: list[float]) -> dict[str, float]:
    ordered=sorted(samples)
    return {'p50_ms':ordered[len(ordered)//2], 'p99_ms':ordered[math.ceil(len(ordered)*.99)-1], 'max_ms':max(ordered)}


async def run(backend: str, history: int, samples: int = 200, concurrency: int = 16) -> None:
    url=os.getenv('FLOWFN_'+backend.upper()+'_URL')
    if not url:
        return
    if backend=='redis':
        adapter_type: type[RedisAdapter] | type[PostgresAdapter] = RedisAdapter
    else:
        adapter_type = PostgresAdapter
    adapter=adapter_type(url,namespace='benchmark-'+uuid.uuid4().hex)
    try:
        legacy=MemoryAdapter()
        legacy._queues['history']=[Job(id=str(i),name='old',data={},timestamp=0,state=JobStatus.COMPLETED) for i in range(history)]
        payload=adapter._encode(legacy)
        if isinstance(adapter, RedisAdapter):
            await adapter.client.set(adapter.state_key,payload)
        else:
            pool=await adapter._database()
            await pool.execute('INSERT INTO flowfn_py_state VALUES($1,$2)',adapter.namespace,payload)
        await adapter.migrate_legacy_queues()
        enqueues,dequeues=[],[]
        for i in range(samples):
            job=Job(id=str(i),name='new',data={},timestamp=0,opts=JobOptions(remove_on_complete=True))
            start=time.perf_counter()
            await adapter.enqueue('active',job)
            enqueues.append((time.perf_counter()-start)*1000)
            start=time.perf_counter()
            claim=await adapter.dequeue('active')
            dequeues.append((time.perf_counter()-start)*1000)
            assert claim is not None
            claim.state=JobStatus.COMPLETED
            await adapter.update_job('active',claim)
        gate=asyncio.Semaphore(concurrency)
        async def enqueue(i: int) -> None:
            async with gate:
                await adapter.enqueue('throughput',Job(id=str(i),name='load',data={},timestamp=0,opts=JobOptions(remove_on_complete=True)))
        await asyncio.gather(*(adapter.enqueue('warmup',Job(id=str(i),name='warm',data={},timestamp=0)) for i in range(concurrency)))
        start=time.perf_counter()
        await asyncio.gather(*(enqueue(i) for i in range(samples)))
        elapsed=time.perf_counter()-start
        async def process() -> int:
            count=0
            while True:
                claim=await adapter.dequeue('throughput')
                if claim is None:
                    return count
                claim.state=JobStatus.COMPLETED
                await adapter.update_job('throughput',claim)
                count+=1
        start=time.perf_counter()
        completed=sum(await asyncio.gather(*(process() for _ in range(concurrency))))
        processing_elapsed=time.perf_counter()-start
        assert completed==samples
        print(json.dumps({'backend':backend,'unrelated_retained':history,'samples':samples,'enqueue':metrics(enqueues),'dequeue':metrics(dequeues),'enqueue_concurrency':concurrency,'enqueues_per_second':samples/elapsed,'claimed_and_completed_per_second':completed/processing_elapsed}),flush=True)
    finally:
        if isinstance(adapter, RedisAdapter):
            keys=[key async for key in adapter.client.scan_iter(match=adapter.prefix+':*')]
            if keys:
                await adapter.client.delete(*keys)
        else:
            pool=await adapter._database()
            async with pool.acquire() as connection, connection.transaction():
                for table in ('job_edges','job_outcomes','dead_letters','jobs','queue_layout','state'):
                    await connection.execute('DELETE FROM flowfn_py_'+table+' WHERE namespace=$1',adapter.namespace)
        await adapter.cleanup()


async def main() -> None:
    for backend in ('redis','postgres'):
        for history in (0,5000):
            await run(backend,history)


if __name__=='__main__':
    asyncio.run(main())
