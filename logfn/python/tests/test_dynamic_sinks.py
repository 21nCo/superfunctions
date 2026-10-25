import asyncio

import pytest

from logfn import Logger
from logfn.types import LogEvent


def test_children_share_attachment_and_idempotent_detach() -> None:
    events: list[LogEvent] = []
    logger = Logger('parent', [lambda _: None])
    before = logger.child(name='before')
    detach = logger.add_sink(lambda batch: events.extend(batch))
    after = logger.child(name='after')
    before.info('one')
    after.info('two')
    logger.info('three')
    assert [event['name'] for event in events] == ['before', 'after', 'parent']
    detach()
    detach()
    before.info('ignored')
    after.info('ignored')
    assert len(events) == 3


async def test_async_failure_remains_owned_after_detach() -> None:
    gate = asyncio.Event()
    logger = Logger('parent', [lambda _: None], on_error=lambda *_: None)
    async def sink(batch: list[LogEvent]) -> None:
        await gate.wait()
        raise RuntimeError('storage unavailable')
    detach = logger.add_sink(sink)
    logger.child().info('pending')
    detach()
    flushing = asyncio.create_task(logger.flush())
    await asyncio.sleep(0)
    assert not flushing.done()
    gate.set()
    with pytest.raises(RuntimeError, match='storage unavailable'):
        await flushing
    await logger.flush()


async def test_isolated_redacted_copies_buffer_flush_and_unhashable_sink() -> None:
    class Capture:
        def __eq__(self, other: object) -> bool:
            return self is other
        def __init__(self) -> None:
            self.events: list[LogEvent] = []
            self.flushes = 0
        def __call__(self, batch: list[LogEvent]) -> None:
            self.events.extend(batch)
        async def flush(self) -> None:
            self.flushes += 1
    logger = Logger('parent', [lambda _: None])
    logger.add_sink(lambda batch: batch[0].update(msg='mutated'))
    sink = Capture()
    first = logger.add_sink(sink)
    second = logger.child().add_sink(sink)
    logger.info('safe', {'password': 'private-password'})
    await logger.flush()
    assert len(sink.events) == sink.flushes == 1
    assert sink.events[0]['msg'] == 'safe'
    assert 'private-password' not in str(sink.events)
    first()
    logger.info('still attached')
    assert len(sink.events) == 2
    second()
    logger.info('detached')
    assert len(sink.events) == 2


async def test_sync_failure_reaches_flush_without_interrupting_other_sinks() -> None:
    logger = Logger('parent', [lambda _: None], on_error=lambda *_: None)
    events: list[LogEvent] = []
    def fail(batch: list[LogEvent]) -> None:
        raise RuntimeError('sync failure')
    logger.add_sink(fail)
    logger.add_sink(lambda batch: events.extend(batch))
    logger.info('accepted')
    assert len(events) == 1
    with pytest.raises(RuntimeError, match='sync failure'):
        await logger.flush()
    await logger.flush()
