"""Terminal retention preserves dependency and dead-letter semantics in storage."""
from flowfn.queue.queue import Queue
from flowfn.queue.types import JobOptions, JobStatus


async def test_retention_keeps_dependency_until_last_waiter_completes(adapters):
    a, b = adapters
    queue = Queue('retention', a)
    parent = await queue.add('parent', {}, JobOptions(remove_on_complete=True))
    child = await queue.add('child', {}, JobOptions(wait_for=[parent.id], remove_on_complete=True))
    claim = await a.dequeue(queue.name)
    assert claim.id == parent.id
    claim.state = JobStatus.COMPLETED
    await a.update_job(queue.name, claim)
    assert [j.id for j in await b.get_all_jobs(queue.name)] == [child.id]
    claim = await b.dequeue(queue.name)
    assert claim.id == child.id
    claim.state = JobStatus.COMPLETED
    await b.update_job(queue.name, claim)
    assert await a.get_all_jobs(queue.name) == []
    assert a._decode(await a._read_queue_state())._dependency_results == {}


async def test_terminal_count_retention_preserves_failed_dead_letter(adapters):
    a, b = adapters
    queue = Queue('bounded', a)
    retained = []
    for _ in range(4):
        job = await queue.add('ok', {}, JobOptions(remove_on_complete=2))
        claim = await b.dequeue(queue.name)
        claim.state = JobStatus.COMPLETED
        await b.update_job(queue.name, claim)
        retained.append(job.id)
    assert [j.id for j in await a.get_jobs(queue.name, JobStatus.COMPLETED)] == retained[-2:]
    failed = await queue.add('failure', {}, JobOptions(remove_on_fail=True))
    claim = await b.dequeue(queue.name)
    claim.state = JobStatus.FAILED
    claim.failed_reason = 'expected'
    await b.update_job(queue.name, claim)
    assert failed.id not in [j.id for j in await a.get_all_jobs(queue.name)]
    assert [j.id for j in await a.get_dead_letters()] == [failed.id]
    await a.retry_dead_letter(queue.name, failed.id)
    assert await b.get_dead_letters() == []
    assert [j.id for j in await b.get_jobs(queue.name, JobStatus.WAITING)] == [failed.id]
