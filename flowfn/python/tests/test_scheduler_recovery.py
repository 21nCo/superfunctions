from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from flowfn.adapters.redis import RedisAdapter
from flowfn.scheduler import Scheduler
from tests.assertions import require_value
from tests.native_support import NativeAdapters

CHILD = r'''
import asyncio,sys
from flowfn.scheduler import Scheduler
async def main():
 if sys.argv[1]=='redis':
  from flowfn.adapters.redis import RedisAdapter as Adapter
 else:
  from flowfn.adapters.postgres import PostgresAdapter as Adapter
 adapter=Adapter(sys.argv[2],namespace=sys.argv[3])
 scheduler=Scheduler(adapter,lease_ms=1000)
 calls=0
 async def callback(data):
  nonlocal calls
  calls+=1
  if calls==2:
   print('blocked',flush=True)
   await asyncio.Event().wait()
 scheduler.repeat('recover',50,callback,limit=3,data={'value':42})
 await scheduler.ready()
 await asyncio.Event().wait()
asyncio.run(main())
'''


async def test_crash_reclaims_schedule_without_resetting_run_count(adapters: NativeAdapters) -> None:
    a,b=adapters
    backend='redis' if isinstance(a, RedisAdapter) else 'postgres'
    process=await asyncio.create_subprocess_exec(sys.executable,'-c',CHILD,backend,a.test_url,a.namespace,
                                                stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    sa,sb=Scheduler(a,lease_ms=1000),Scheduler(b,lease_ms=1000)
    assert process.stdout is not None
    try:
        assert (require_value(await asyncio.wait_for(process.stdout.readline(),10))).strip()==b'blocked'
        assert (require_value(await a.load_workflow_state('__schedule__:recover'))).state['runs']==1
        process.kill()
        await process.wait()
        await asyncio.sleep(1.2)
        calls=[]
        active=0
        maximum=0

        async def callback(data: Any) -> None:
            nonlocal active,maximum
            assert data=={'value':42}
            active+=1
            maximum=max(maximum,active)
            await asyncio.sleep(.1)
            calls.append(data)
            active-=1

        sa.repeat('recover',50,callback,limit=3,data={'value':42})
        sb.repeat('recover',50,callback,limit=3,data={'value':42})
        await asyncio.gather(sa.ready(),sb.ready())
        for _ in range(200):
            jobs=await sa.list()
            if jobs[0].runs==3:
                break
            await asyncio.sleep(.03)
        assert jobs[0].runs==3 and jobs[0].next_run is None
        assert len(calls)==2 and maximum==1
        fresh=Scheduler(a)
        assert (await fresh.list())[0].runs==3
        await fresh.close()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
        await sa.close()
        await sb.close()


async def test_remote_pause_resume_cancel_and_definition_conflict(adapters: NativeAdapters) -> None:
    a,b=adapters
    owner,remote=Scheduler(a,lease_ms=1000),Scheduler(b,lease_ms=1000)
    calls=[]
    async def callback(data: Any) -> None:
        calls.append(data)
    start=datetime.now(timezone.utc)+timedelta(seconds=.5)
    owner.repeat('controls',50,callback,start_date=start)
    await owner.ready()
    await remote.pause('controls')
    await asyncio.sleep(.6)
    assert calls==[] and (await remote.list())[0].paused
    await remote.resume('controls')
    for _ in range(100):
        if calls:
            break
        await asyncio.sleep(.02)
    assert calls
    await remote.cancel('controls')
    count=len(calls)
    await asyncio.sleep(.2)
    assert len(calls)==count and await remote.list()==[]
    conflict=Scheduler(b)
    conflict.repeat('controls',99,callback)
    with pytest.raises(ValueError,match='definition differs'):
        await conflict.ready()
    await conflict.close()
    await owner.close()
    await remote.close()
