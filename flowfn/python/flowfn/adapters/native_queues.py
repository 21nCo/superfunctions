"""Indexed durable queue transactions shared by database providers.

The projection contains the transition's affected records, not the namespace's
history. Providers serialize a queue transaction and apply only changed rows.
"""
import hashlib
import json
from abc import ABC, abstractmethod
from typing import Any

from flowfn.adapters.memory import MemoryAdapter
from flowfn.adapters.durable_queues import DurableQueues
from flowfn.queue.types import Job, JobStatus


class QueueTransaction(ABC):
    async def prepare(self, method: str, args: tuple[Any, ...], now: int) -> int:
        return now

    @abstractmethod
    async def select(self, kind: str, value: Any = None) -> list[Job]: ...

    @abstractmethod
    async def outcomes(self) -> dict[tuple[str, str], JobStatus]: ...

    @abstractmethod
    async def dead_letters(self, identity: str) -> dict[tuple[str, str], Any]: ...

    @abstractmethod
    async def apply(self, before: MemoryAdapter, after: MemoryAdapter) -> None: ...


async def apply_native(owner: DurableQueues, tx: QueueTransaction, queue: str,
                       method: str, args: tuple[Any, ...], now: int) -> Any:
    if method == 'enqueue':
        incoming = args[1]
        if incoming.opts.prevent_duplicates and incoming.opts.deduplication_key is None:
            raw = json.dumps([incoming.name,incoming.data],sort_keys=True,separators=(',',':'),allow_nan=False)
            incoming.opts.deduplication_key = hashlib.sha256(raw.encode()).hexdigest()
    now = await tx.prepare(method,args,now)
    state = MemoryAdapter()
    jobs: dict[str, Job] = {}

    async def load(kind: str, value: Any = None) -> None:
        for job in await tx.select(kind,value):
            jobs[job.id] = job

    # A renewable claim touches one row regardless of queue/history size.
    if method == '_renew_job':
        await load('id',args[1].id)
    elif method in ('save_dead_letter','delete_dead_letter'):
        identity = args[0].id if method == 'save_dead_letter' else args[1]
        state._dead_letters = await tx.dead_letters(identity)
    else:
        # Graph records include nonterminal dependents and their retained
        # parents. This preserves cycle/failure/retention invariants without
        # loading independent terminal history.
        await load('graph')
        state._dependency_results = await tx.outcomes()
        if method == 'enqueue':
            incoming = args[1]
            await load('id',incoming.id)
            if incoming.opts.prevent_duplicates:
                await load('dedup',incoming.opts.deduplication_key)
        elif method == 'dequeue':
            await load('ready',now)
            await load('expired',now)
            # Dependency failure can trigger count-based failed retention.
            if any(type(j.opts.remove_on_fail) is int for j in jobs.values()):
                await load('state',JobStatus.FAILED)
        elif method == 'update_job':
            incoming = args[1]
            await load('id',incoming.id)
            policy = incoming.opts.remove_on_complete if incoming.state == JobStatus.COMPLETED else incoming.opts.remove_on_fail if incoming.state == JobStatus.FAILED else False
            if type(policy) is int:
                await load('state',incoming.state)
        elif method == 'retry_dead_letter':
            await load('id',args[1])
            state._dead_letters = await tx.dead_letters(args[1])
        elif method == 'clean_jobs':
            await load('state',args[2])
        else:
            raise ValueError('Unknown native queue operation: '+method)
    # Providers return insertion order; combine projections using the stable
    # ordering attached privately by the transaction implementation.
    state._queues[queue] = sorted(jobs.values(),key=lambda job: getattr(job,'_storage_sequence',0))
    before = owner._decode(owner._encode(state))
    result = await owner._apply(state,method,args,now)
    await tx.apply(before,state)
    return result


async def failure_record(queue: str, job: Job) -> str:
    from dataclasses import asdict
    from flowfn.queue.dlq import DLQManager
    if job.state!=JobStatus.FAILED:
        return 'null'
    record=await DLQManager(adapter=MemoryAdapter()).move_to_dlq(job,job.failed_reason or 'Job failed',queue)
    value=asdict(record)
    value['options']=record.options.model_dump(mode='json')
    return json.dumps(value,allow_nan=False)
