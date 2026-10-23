import asyncio

import pytest

from flowfn import create_flow
from flowfn.stream.types import ConsumerOptions


async def eventually(predicate):
    async def wait():
        while not predicate():
            await asyncio.sleep(0)

    await asyncio.wait_for(wait(), 2)


@pytest.mark.asyncio
async def test_members_share_work_but_groups_receive_independent_copies():
    flow = create_flow()
    stream = flow.stream("events")
    first, second = [], []

    async def receive_first(message):
        first.append(message.data)
        await message.ack()

    async def receive_second(message):
        second.append(message.data)
        await message.ack()

    for name in ("a", "b"):
        await stream.create_consumer(
            name, ConsumerOptions(group_id="one", max_in_flight=1)
        ).subscribe(receive_first)
    await stream.create_consumer("a", ConsumerOptions(group_id="two", max_in_flight=1)).subscribe(
        receive_second
    )
    for i in range(8):
        await stream.publish(i)
    await eventually(lambda: len(first) == 8 and len(second) == 8)
    assert sorted(first) == sorted(second) == list(range(8))
    assert (await stream.get_info()).groups == 2
    await stream.close()
    assert all(not group.consumers for group in flow._adapter._groups.values())
    await flow.close()


@pytest.mark.asyncio
async def test_manual_ack_bounds_delivery_and_disconnect_redelivers_pending():
    flow = create_flow()
    stream = flow.stream("pending")
    first, resumed = [], []

    async def receive(message):
        first.append(message)

    old = stream.create_consumer("old", ConsumerOptions(group_id="group", max_in_flight=1))
    await old.subscribe(receive)
    await stream.publish(1)
    await stream.publish(2)
    await eventually(lambda: len(first) == 1)
    await asyncio.sleep(0.01)
    assert len(first) == 1
    await old.close()

    async def replay(message):
        resumed.append(message.data)
        await message.ack()

    new = stream.create_consumer("new", ConsumerOptions(group_id="group", max_in_flight=1))
    await new.subscribe(replay)
    await eventually(lambda: len(resumed) == 2)
    assert sorted(resumed) == [1, 2]
    await first[0].ack()  # Stale acknowledgement cannot settle another delivery.
    await flow.close()


@pytest.mark.asyncio
async def test_nack_requeue_and_historical_auto_commit():
    flow = create_flow()
    stream = flow.stream("history")
    await stream.publish("old")
    seen = []

    async def receive(message):
        seen.append(message.data)
        if len(seen) == 1:
            await message.nack(requeue=True)

    consumer = stream.create_consumer(
        "reader",
        ConsumerOptions(
            group_id="historical", from_beginning=True, auto_commit=True, max_in_flight=1
        ),
    )
    await consumer.subscribe(receive)
    await eventually(lambda: len(seen) == 2)
    await stream.publish("new")
    await eventually(lambda: len(seen) == 3)
    assert seen == ["old", "old", "new"]
    await flow.close()


@pytest.mark.asyncio
async def test_pause_resume_and_duplicate_identity():
    flow = create_flow()
    stream = flow.stream("paused")
    seen = []

    async def receive(message):
        seen.append(message.data)
        await message.ack()

    opts = ConsumerOptions(group_id="group", max_in_flight=1)
    consumer = stream.create_consumer("reader", opts)
    await consumer.pause()
    await consumer.subscribe(receive)
    await stream.publish("pending")
    await asyncio.sleep(0.01)
    assert seen == []
    duplicate = stream.create_consumer("reader", opts)
    with pytest.raises(ValueError, match="already registered"):
        await duplicate.subscribe(receive)
    await consumer.resume()
    await eventually(lambda: len(seen) == 1)
    await flow.close()


@pytest.mark.asyncio
async def test_retention_and_replay_use_shared_adapter_not_instance_cache():
    from flowfn.stream.stream import Stream
    from flowfn.stream.types import TrimStrategy

    flow = create_flow()
    stream = flow.stream("retained", {"max_length": 2})
    for number in range(3):
        await stream.publish(number)
    other = Stream("retained", flow._adapter)
    assert (await other.get_info()).length == 2
    replayed = []

    async def collect(message):
        replayed.append(message.data)

    assert await other.replay(0, collect) == 2
    assert replayed == [1, 2]
    assert await other.trim(TrimStrategy(max_length=0)) == 2
    assert await stream.get_message_count() == 0
    await other.close()
    await flow.close()
