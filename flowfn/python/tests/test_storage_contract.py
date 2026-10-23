from __future__ import annotations

from typing import TypedDict

import pytest

from flowfn.patterns.priority import PriorityQueue
from flowfn.queue.types import Job
from flowfn.storage.event_log import Event, FilterOptions, MemoryEventLog
from flowfn.storage.job_storage import ListOptions, MemoryJobStorage
from tests.assertions import require_value


class RankedItem(TypedDict):
    rank: int
    id: str


def test_priority_comparator_and_fifo_ties() -> None:
    queue: PriorityQueue[RankedItem] = PriorityQueue(lambda left, right: left["rank"] - right["rank"])
    items: list[RankedItem] = [
        {"rank": 2, "id": "last"},
        {"rank": 1, "id": "first"},
        {"rank": 1, "id": "second"},
    ]
    for item in items:
        queue.enqueue(item)
    assert [require_value(queue.dequeue())["id"] for _ in range(3)] == ["first", "second", "last"]
    numbers: PriorityQueue[float] = PriorityQueue()
    for number in [3, 1.5, 2]:
        numbers.enqueue(number)
    assert [numbers.dequeue() for _ in range(3)] == [1.5, 2, 3]
    numbers.enqueue(3)
    numbers.enqueue(99, priority=1)
    assert [numbers.dequeue(), numbers.dequeue()] == [99, 3]


@pytest.mark.asyncio
async def test_event_snapshot_and_unambiguous_version_scope() -> None:
    log = MemoryEventLog()
    event = Event(
        id="first",
        aggregate_type="a:b",
        aggregate_id="c",
        type="changed",
        data={"value": [1]},
        timestamp=1,
        version=0,
    )

    async def mutate(delivered: Event) -> None:
        delivered.data["value"].append(9)

    await log.subscribe(mutate)
    await log.append(event)
    event.data["value"].append(2)
    await log.append(
        Event(
            id="second",
            aggregate_type="a",
            aggregate_id="b:c",
            type="changed",
            data={},
            timestamp=2,
            version=0,
        )
    )
    found = await log.get_events()
    assert [entry.version for entry in found] == [1, 1]
    assert found[0].data == {"value": [1]}
    found[0].data["value"].append(3)
    assert (await log.get_aggregate_events("c"))[0].data == {"value": [1]}
    assert await log.get_events(FilterOptions(limit=0)) == []


@pytest.mark.asyncio
async def test_job_storage_snapshots_and_pagination_validation() -> None:
    store = MemoryJobStorage()
    job = Job(id="one", name="test", data={"value": []}, timestamp=1)
    await store.save(job)
    job.data["value"].append("outside")
    found = await store.get(job.id)
    assert found is not None
    assert found.data == {"value": []}
    found.data["value"].append("read")
    assert (await store.list())[0].data == {"value": []}
    with pytest.raises(ValueError, match="Pagination"):
        await store.list(ListOptions(offset=-1))
