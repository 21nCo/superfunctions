"""Local native 1-second lease diagnosis; run via provider-acceptance with PYTEST_ADDOPTS.

PYTEST_ADDOPTS='../.conduct/heartbeat_diagnostics.py -k heartbeat_diagnostic -s' \
  node flowfn/typescript/scripts/provider-acceptance.mjs --python
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import pytest
from flowfn.adapters.postgres import PostgresAdapter
from flowfn.queue.types import Job
from tests.native_support import NativeAdapters

pytest_plugins = ["tests.test_durable_adapters"]


@pytest.mark.parametrize('transient', [False, True])
@pytest.mark.parametrize('iteration', range(3))
async def test_heartbeat_diagnostic(adapters: NativeAdapters, monkeypatch: pytest.MonkeyPatch,
                                    transient: bool, iteration: int) -> None:
    a, b = adapters
    events: list[dict[str, Any]] = []
    started = time.monotonic()
    original = a._transition
    failed = False
    successes = 0
    def record(kind: str, **values: Any) -> None:
        events.append({'t_ms': round((time.monotonic()-started)*1000, 3),
                       'wall_ms': int(time.time()*1000), 'kind': kind, **values})
    async def transition(method: str, *args: Any) -> Any:
        nonlocal failed, successes
        begin = time.monotonic()
        record('begin', method=method)
        try:
            if transient and method == '_renew_job' and not failed:
                failed = True
                raise ConnectionError('transient fixture')
            value = await original(method, *args)
            if method == '_renew_job':
                successes += 1
            record('done', method=method, elapsed_ms=(time.monotonic()-begin)*1000)
            return value
        except BaseException as error:
            record('error', method=method, elapsed_ms=(time.monotonic()-begin)*1000,
                   error=type(error).__name__, detail=str(error))
            raise
    monkeypatch.setattr(a, '_transition', transition)
    lags: list[float] = []
    async def observe_loop() -> None:
        while True:
            before = time.monotonic()
            await asyncio.sleep(.01)
            lags.append(max(0, (time.monotonic()-before)*1000-10))
    monitor = asyncio.create_task(observe_loop())
    try:
        await a.enqueue('diagnostic', Job(id='held', name='held', data={}, timestamp=0))
        if isinstance(a, PostgresAdapter):
            pool = await a._database()
            def query(event: Any) -> None:
                record('sql', query=event.query[:110], elapsed_ms=event.elapsed*1000,
                       error=repr(event.exception))
            # Diagnostic-only access to live pool connections; no query timing is modified.
            for holder in pool._holders:
                if holder._con is not None:
                    holder._con.add_query_logger(query)
        claimed = await a.dequeue('diagnostic')
        assert claimed is not None
        record('claimed', lease_expires_at=claimed.lease_expires_at,
               processed_on=claimed.processed_on, token=claimed.lease_token)
        event = a.lease_loss_event('diagnostic', claimed)
        assert event is not None
        await asyncio.sleep(2.5)
        record('before_competitor', lost=event.is_set(), renewals=successes,
               backend=await a.health_probe())
        other = await b.dequeue('diagnostic')
        record('competitor', claimed=other.model_dump(mode='json') if other else None,
               lost=event.is_set(), backend=await b.health_probe())
        assert other is None
        assert not event.is_set()
        assert successes >= 2
    finally:
        monitor.cancel()
        await asyncio.gather(monitor, return_exceptions=True)
        print('HEARTBEAT_DIAGNOSTIC '+json.dumps({
            'backend': type(a).__name__, 'iteration': iteration, 'transient': transient,
            'max_loop_lag_ms': max(lags, default=0), 'events': events}), flush=True)


async def test_heartbeat_delayed_reply_diagnostic(adapters: NativeAdapters,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    """Actual native transitions with an explicit 450ms response-delivery delay."""
    a, b = adapters
    original = a._transition
    events: list[dict[str, Any]] = []
    started = time.monotonic()
    async def delayed(method: str, *args: Any) -> Any:
        begin = time.monotonic()
        result = await original(method, *args)
        if method in ('dequeue', '_renew_job'):
            await asyncio.sleep(.45)
        events.append({'method': method, 'begin_ms': (begin-started)*1000,
                       'end_ms': (time.monotonic()-started)*1000})
        return result
    monkeypatch.setattr(a, '_transition', delayed)
    await a.enqueue('reply-delay', Job(id='held', name='held', data={}, timestamp=0))
    claimed = await a.dequeue('reply-delay')
    assert claimed is not None
    lost = a.lease_loss_event('reply-delay', claimed)
    assert lost is not None
    await asyncio.sleep(1.6)
    other = await b.dequeue('reply-delay')
    print('HEARTBEAT_DELAYED_REPLY '+json.dumps({
        'backend': type(a).__name__, 'lost': lost.is_set(),
        'competitor_claimed': other is not None, 'events': events}), flush=True)
    assert not lost.is_set()
    assert other is None
