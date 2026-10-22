import asyncio
import pytest
from logfn.core import Logger


async def test_parent_flush_joins_child_delivery_before_hook():
    started, release = asyncio.Event(), asyncio.Event()
    received = []
    class Sink:
        async def __call__(self, batch):
            started.set()
            await release.wait()
            received.extend(batch)
        async def flush(self):
            assert len(received) == 1
    logger = Logger('parent', [Sink()])
    logger.child(name='child').info('accepted')
    await started.wait()
    flush = asyncio.create_task(logger.flush())
    await asyncio.sleep(0)
    assert not flush.done()
    release.set()
    await flush
    assert received[0]['name'] == 'child'


async def test_completed_failure_is_reported_after_all_hooks():
    flushed = []
    class Broken:
        async def __call__(self, batch):
            raise ValueError('delivery failed')
        async def flush(self):
            flushed.append('broken')
    class Healthy:
        def __call__(self, batch):
            pass
        async def flush(self):
            await asyncio.sleep(0)
            flushed.append('healthy')
    logger = Logger('test', [Broken(), Healthy()])
    logger.info('message')
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    with pytest.raises(ValueError, match='delivery failed'):
        await logger.flush()
    assert sorted(flushed) == ['broken', 'healthy']
    await logger.flush()


async def test_cancelled_flush_preserves_delivery():
    started, release = asyncio.Event(), asyncio.Event()
    delivered = []
    async def sink(batch):
        started.set()
        await release.wait()
        delivered.extend(batch)
    logger = Logger('test', [sink])
    logger.info('message')
    await started.wait()
    flush = asyncio.create_task(logger.flush())
    await asyncio.sleep(0)
    flush.cancel()
    with pytest.raises(asyncio.CancelledError):
        await flush
    release.set()
    await logger.flush()
    assert len(delivered) == 1


async def test_future_sink_and_all_flush_hooks_are_awaited():
    future = asyncio.get_running_loop().create_future()
    completed = []
    class Broken:
        def __call__(self, batch):
            return future
        def flush(self):
            raise ValueError('flush failed')
    class Healthy:
        def __call__(self, batch):
            pass
        async def flush(self):
            await asyncio.sleep(0)
            completed.append(True)
    logger = Logger('test', [Broken(), Healthy()])
    logger.info('message')
    waiter = asyncio.create_task(logger.flush())
    await asyncio.sleep(0)
    assert not waiter.done()
    future.set_result(None)
    with pytest.raises(ValueError, match='flush failed'):
        await waiter
    assert completed == [True]
