"""One owned loop thread; stop joins tasks before WatchFn storage closes."""
import asyncio
from copy import deepcopy
from datetime import datetime,timezone
import threading
import time
from uuid import uuid4
from ..alerts.lifecycle import LifecycleCallbacks,owned_operation
from ..storage.events import CanonicalBusinessEvent
from .checks import validate,run
from . import reports


class Synthetics:
    def __init__(self,watch):
        self.watch=watch;self._callbacks=LifecycleCallbacks();self._callbacks.stop()
        self._lock=threading.RLock();self._stop_lock=threading.Lock();self._loop=None;self._thread=None;self._checks={};self._failures=[];self._closing=False

    def start(self):
        with self._lock:
            if self._thread is not None:raise RuntimeError('Synthetic scheduler is still active')
            self._closing=False;self._callbacks.start()

    def assert_can_stop(self):
        self._callbacks.assert_can_stop()
        if threading.current_thread() is self._thread:raise RuntimeError('Cannot stop WatchFn from its synthetic storage callback')

    def _ensure_loop(self):
        if self._loop is not None:return
        loop=asyncio.new_event_loop();ready=threading.Event()
        def serve():
            asyncio.set_event_loop(loop);ready.set()
            try:loop.run_forever()
            finally:loop.run_until_complete(loop.shutdown_asyncgens());loop.run_until_complete(loop.shutdown_default_executor());loop.close()
        self._loop=loop;self._thread=threading.Thread(target=serve,name='watchfn-synthetics',daemon=False)
        try:self._thread.start()
        except BaseException:
            self._loop=None;self._thread=None;loop.close();raise
        ready.wait()

    @owned_operation
    def create(self,source):
        check=validate(source)
        try:
            import httpx
            from logfn import default_redactor
        except ImportError as error:raise RuntimeError('Install watchfn[synthetics] for HTTP synthetic execution') from error
        # Header validity is checked before reserving an ID or starting a thread.
        httpx.Headers(check.get('headers',{}));redact=default_redactor()
        with self._lock:
            if not self.watch.is_started or self._closing:raise RuntimeError('Synthetic scheduler is unavailable')
            if check['id'] in self._checks:raise ValueError('Synthetic check ID already exists')
            if len(self._checks)>=100:raise ValueError('Synthetic check capacity exceeded')
            self._ensure_loop()
            future=asyncio.run_coroutine_threadsafe(self._repeat(check,httpx,redact),self._loop)
            self._checks[check['id']]=future
        return deepcopy(check)

    async def _repeat(self,check,httpx,redact):
        try:
            while True:
                started=int(time.time()*1000);begin=time.monotonic();identifier=str(uuid4())
                for attempt in range(check['retries']+1):
                    result=await run(check,httpx,redact)
                    if result['success'] or attempt==check['retries']:break
                with self._lock:
                    if self._closing:return
                    result.update(startedAt=started,runId=identifier,attempts=attempt+1,totalDuration=(time.monotonic()-begin)*1000)
                    event=CanonicalBusinessEvent(type='track',name='synthetics.check',app={'name':self.watch.config.name},timestamp=datetime.fromtimestamp(result['timestamp']/1000,timezone.utc),properties=result)
                    self.watch.storage.add(event)
                await asyncio.sleep(check['interval']/1000)
        except asyncio.CancelledError:raise
        except Exception as error:
            with self._lock:self._failures.append(error)

    async def _cancel(self):
        tasks=[task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
        for task in tasks:task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)

    def stop(self):
        self.assert_can_stop()
        with self._stop_lock:self._stop()

    def _stop(self):
        self._callbacks.stop()
        with self._lock:
            self._closing=True;loop=self._loop;thread=self._thread
        try:
            if loop is not None:
                try:asyncio.run_coroutine_threadsafe(self._cancel(),loop).result()
                finally:loop.call_soon_threadsafe(loop.stop);thread.join()
        finally:
            with self._lock:
                self._loop=None;self._thread=None;self._checks.clear();failures=self._failures;self._failures=[]
        if failures:raise RuntimeError('Synthetic result persistence failed') from failures[0]

    def _report(self,function,options):
        if not self.watch.is_started or self._closing:raise RuntimeError('Synthetic scheduler is unavailable')
        if not isinstance(options,dict):raise ValueError('Invalid synthetic report options')
        options=deepcopy(options);self.watch.flush()
        return function(self.watch.storage,self.watch.config.name,options)

    @owned_operation
    def get_uptime(self,options):return self._report(reports.uptime,options)
    @owned_operation
    def get_incidents(self,options):return self._report(reports.incidents,options)
    @owned_operation
    def get_performance_trend(self,options):return self._report(reports.trend,options)
