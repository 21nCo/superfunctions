import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from flowfn import create_flow
from flowfn.scheduler import Scheduler


async def test_repeat_limits_errors_and_snapshot_isolation():
    scheduler = Scheduler()
    calls = []
    done = asyncio.Event()

    async def callback(data):
        calls.append(data)
        if len(calls) == 1:
            raise ValueError('transient')
        done.set()

    scheduler.repeat('repeat', 5, callback, limit=2, data=42)
    await asyncio.wait_for(done.wait(), 1)
    await asyncio.sleep(.03)
    assert calls == [42, 42]
    job = (await scheduler.list())[0]
    assert job.runs == 2 and job.next_run is None and job.last_error is None
    job.runs = 99
    assert (await scheduler.list())[0].runs == 2
    await scheduler.close()


async def test_pause_resume_and_shutdown_cancel_running_callback():
    flow = create_flow()
    scheduler = flow.scheduler()
    entered = asyncio.Event()
    cleaned = asyncio.Event()

    async def callback(data):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    scheduler.repeat('paused', 10, callback)
    await scheduler.pause('paused')
    await asyncio.sleep(.03)
    assert not entered.is_set()
    await scheduler.resume('paused')
    await asyncio.wait_for(entered.wait(), 1)
    await flow.close()
    assert cleaned.is_set()
    assert await scheduler.list() == []
    with pytest.raises(RuntimeError):
        scheduler.repeat('closed', 1, callback)


async def test_cron_timezone_validation_and_unique_names():
    scheduler = Scheduler()

    async def callback(data):
        pass

    job = scheduler.schedule('cron', '0 9 * * MON', callback, timezone_name='America/New_York')
    assert job.next_run.weekday() == 0
    assert job.next_run.hour == 9
    assert str(job.next_run.tzinfo) == 'America/New_York'
    with pytest.raises(ValueError):
        scheduler.schedule('bad', '* * * * * *', callback)
    with pytest.raises(ValueError):
        scheduler.repeat('cron', 1, callback)
    for invalid in (0, -1, float('nan'), float('inf')):
        with pytest.raises(ValueError):
            scheduler.repeat('bad', invalid, callback)
    with pytest.raises(ValueError):
        scheduler.repeat('bad', 1, callback, start_date=datetime.now())
    await scheduler.cancel('cron')
    await scheduler.close()


async def test_future_start_and_slow_callbacks_do_not_overlap():
    scheduler = Scheduler()
    active = 0
    maximum = 0
    done = asyncio.Event()
    calls = 0

    async def callback(data):
        nonlocal active, maximum, calls
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(.02)
        active -= 1
        calls += 1
        if calls == 2:
            done.set()

    scheduler.repeat('slow', 5, callback, limit=2,
                     start_date=datetime.now(timezone.utc) + timedelta(seconds=.06))
    await asyncio.sleep(.02)
    assert calls == 0 and active == 0
    await asyncio.wait_for(done.wait(), 1)
    assert maximum == 1
    await scheduler.close()
