"""Native record storage preserves legacy semantics and migration boundaries."""
import asyncio
import json
import time

import pytest

from flowfn.adapters.memory import MemoryAdapter
from flowfn.queue.types import Job, JobOptions, JobStatus


async def test_explicit_atomic_legacy_migration_preserves_history_and_claims(adapters):
    a,b=adapters
    # Migration exercises schema/data conversion, independently of the tight-lease tests.
    a.reclaim_after_ms=b.reclaim_after_ms=30000
    legacy=MemoryAdapter()
    for i in range(1000):
        legacy._queues['history'].append(Job(id=str(i),name='old',data={},timestamp=0,state=JobStatus.COMPLETED))
    legacy._queues['work']=[Job(id='waiting',name='next',data={'preserved':True},timestamp=0)]
    legacy._queues['active']=[Job(id='owned',name='active',data={},timestamp=0,state=JobStatus.ACTIVE,lease_token='legacy-token',lease_expires_at=int(time.time()*1000)+600000)]
    legacy._queues['dependent']=[Job(id='child',name='child',data={},timestamp=0,opts=JobOptions(wait_for=['removed-parent']))]
    legacy._dependency_results[('dependent','removed-parent')]=JobStatus.COMPLETED
    failed=Job(id='failed',name='failed',data={},timestamp=0,state=JobStatus.FAILED,opts=JobOptions(remove_on_fail=True))
    legacy._queues['failed']=[failed]
    await legacy.update_job('failed',failed)
    raw=a._encode(legacy)
    if hasattr(a,'client'):
        await a.client.set(a.state_key,raw)
    else:
        pool=await a._database()
        await pool.execute('INSERT INTO flowfn_py_state VALUES($1,$2)',a.namespace,raw)
    with pytest.raises(RuntimeError,match='stop old workers'):
        await a.dequeue('work')
    await asyncio.gather(a.migrate_legacy_queues(),b.migrate_legacy_queues())
    claims=await asyncio.gather(a.dequeue('work'),b.dequeue('work'))
    assert sum(j is not None for j in claims)==1
    claim=next(j for j in claims if j is not None)
    assert claim.data=={'preserved':True}
    claim.state=JobStatus.COMPLETED
    await a.update_job('work',claim)
    assert len(await b.get_all_jobs('history'))==1000
    assert await b.dequeue('active') is None
    assert (await b.get_all_jobs('active'))[0].lease_token=='legacy-token'
    dependent=await b.dequeue('dependent')
    assert dependent.id=='child'
    dependent.state=JobStatus.COMPLETED
    await b.update_job('dependent',dependent)
    assert [record.id for record in await a.get_dead_letters()]==['failed']
    await a.retry_dead_letter('failed','failed')
    assert await b.get_dead_letters()==[]
    await a.migrate_legacy_queues()
    assert len(await b.get_all_jobs('work'))==1
    if hasattr(a,'client'):
        persisted=await a.client.get(a.state_key)
    else:
        persisted=await pool.fetchval('SELECT payload FROM flowfn_py_state WHERE namespace=$1',a.namespace)
    assert json.loads(persisted)==json.loads(raw)  # archived snapshot never rewritten


async def test_ready_index_priority_fifo_due_and_dependency_failure(adapters):
    a,b=adapters
    now=int(time.time()*1000)
    for identity,priority in [('z-first',2),('a-second',2),('priority',1)]:
        await a.enqueue('q',Job(id=identity,name='job',data={},timestamp=now,opts=JobOptions(priority=priority)))
    for identity in ('priority','z-first','a-second'):
        claim=await b.dequeue('q')
        assert claim.id==identity
        claim.state=JobStatus.COMPLETED
        await b.update_job('q',claim)
    now=int(time.time()*1000)
    delayed=Job(id='future',name='job',data={},timestamp=now,available_at=now+1000,state=JobStatus.WAITING,opts=JobOptions(priority=0))
    await a.enqueue('q',delayed)
    assert await b.dequeue('q') is None
    await asyncio.sleep(max(0,(now+1050-int(time.time()*1000))/1000))
    claim=await b.dequeue('q')
    assert claim.id=='future'
    claim.state=JobStatus.FAILED
    await b.update_job('q',claim)
    child=Job(id='child',name='job',data={},timestamp=now,opts=JobOptions(wait_for=['future'],remove_on_fail=True))
    grandchild=Job(id='grandchild',name='job',data={},timestamp=now,opts=JobOptions(wait_for=['child']))
    await a.enqueue('q',child)
    await a.enqueue('q',grandchild)
    assert await b.dequeue('q') is None
    assert {j.id for j in await a.get_dead_letters()}=={'future','child','grandchild'}
    assert 'child' not in {j.id for j in await a.get_all_jobs('q')}
    assert next(j for j in await a.get_all_jobs('q') if j.id=='grandchild').state==JobStatus.FAILED


async def test_native_json_payload_and_empty_dedup_key_round_trip(adapters):
    a,b=adapters
    data={'state':[], 'lease_token': {'lease_expires_at':[]}, 'quoted':'"},\\"state\\":[]', 'arrays':[[],{},[[]]], 'unicode':'雪'}
    first=Job(id='first',name='payload',data=data,timestamp=0,opts=JobOptions(prevent_duplicates=True,deduplication_key=''))
    duplicate=Job(id='duplicate',name='payload',data={},timestamp=0,opts=JobOptions(prevent_duplicates=True,deduplication_key=''))
    await a.enqueue('json',first)
    assert (await b.enqueue('json',duplicate)).id=='first'
    claim=await a.dequeue('json')
    assert claim.data==data
    await asyncio.sleep(.45)  # exercise native heartbeat JSON scalar update
    assert (await b.get_all_jobs('json'))[0].data==data
    claim.returnvalue={'empty':[], 'nested':data}
    claim.state=JobStatus.COMPLETED
    await a.update_job('json',claim)
    persisted=(await b.get_all_jobs('json'))[0]
    assert persisted.returnvalue==claim.returnvalue
    assert persisted.data==data


async def test_different_queue_progresses_while_graph_transaction_is_blocked(adapters):
    a,b=adapters
    # Establish connections and migrate the namespace before timing queue isolation.
    await a.get_all_jobs('blocked')
    await b.get_all_jobs('independent')
    started,release=asyncio.Event(),asyncio.Event()
    original=a._apply
    async def blocked(state,method,args,now):
        if method=='enqueue' and args[0]=='blocked':
            started.set()
            await release.wait()
        return await original(state,method,args,now)
    a._apply=blocked
    task=asyncio.create_task(a.enqueue('blocked',Job(id='waiting',name='job',data={},timestamp=0,opts=JobOptions(wait_for=['future']))))
    try:
        await asyncio.wait_for(started.wait(),3)
        await asyncio.wait_for(b.enqueue('independent',Job(id='ready',name='job',data={},timestamp=0)),1)
        claim=await asyncio.wait_for(b.dequeue('independent'),1)
        assert claim.id=='ready'
    finally:
        release.set()
        await task


async def test_failed_handler_uses_one_atomic_dlq_transition(adapters):
    from flowfn.queue.queue import Queue
    a,b=adapters
    queue=Queue('failure',a)
    job=await queue.add('fail',{},JobOptions(attempts=1,remove_on_fail=True))
    claim=await a.dequeue(queue.name)
    async def unexpected(*args):
        raise AssertionError('A second DLQ write could resurrect a concurrently retried dead letter')
    a.save_dead_letter=unexpected
    async def fail(job):
        raise ValueError('expected')
    await queue._process_job(claim,fail)
    assert [record.id for record in await b.get_dead_letters()]==[job.id]
    await b.retry_dead_letter(queue.name,job.id)
    assert await a.get_dead_letters()==[]


async def test_concurrent_native_claims_and_completions_are_unique(adapters):
    a,b=adapters
    a.reclaim_after_ms=b.reclaim_after_ms=5000
    await asyncio.gather(*(a.enqueue('parallel',Job(id=str(i),name='job',data={},timestamp=0)) for i in range(24)))
    owners=[a,b]*12
    claims=await asyncio.gather(*(owner.dequeue('parallel') for owner in owners))
    assert all(claim is not None for claim in claims)
    assert len({claim.id for claim in claims})==24
    for claim in claims:
        claim.state=JobStatus.COMPLETED
    await asyncio.gather(*(owner.update_job('parallel',claim) for owner,claim in zip(owners,claims)))
    stats=await a.get_queue_stats('parallel')
    assert stats.completed==24
    assert stats.active==stats.waiting==0


@pytest.mark.parametrize('operation',['renew','complete'])
async def test_postgres_row_lock_wait_cannot_revive_expired_owner(adapters,operation):
    a,b=adapters
    if not hasattr(a,'_database'):
        pytest.skip('PostgreSQL row-lock fencing regression')
    a.reclaim_after_ms=30000
    await a.enqueue('locked',Job(id='one',name='job',data={},timestamp=0))
    claim=await a.dequeue('locked')
    await a.release_job_lease('locked',claim)
    pool=await a._database()
    lock=json.dumps([a.namespace,'locked'])
    async with pool.acquire() as connection, connection.transaction():
        await connection.execute("UPDATE flowfn_py_jobs SET lease=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint+300 WHERE namespace=$1 AND queue='locked' AND id='one'",a.namespace)
        if operation=='renew':
            task=asyncio.create_task(pool.fetchval('SELECT flowfn_py_renew_v2($1,$2,$3,$4,$5,$6)',a.namespace,'locked',lock,claim.id,claim.lease_token,30000))
        else:
            claim.state=JobStatus.COMPLETED
            task=asyncio.create_task(pool.fetchval('SELECT flowfn_py_update_v2($1,$2,$3,$4,$5,$6)',a.namespace,'locked',lock,claim.model_dump_json(),30000,'null'))
        await asyncio.sleep(.6)
        assert not task.done(), 'The transition must be waiting for the held job row'
    assert await task == 0
    row=await pool.fetchrow("SELECT state,lease FROM flowfn_py_jobs WHERE namespace=$1 AND queue='locked' AND id='one'",a.namespace)
    assert row['state']=='active'
