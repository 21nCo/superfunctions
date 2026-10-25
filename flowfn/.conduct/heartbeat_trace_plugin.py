"""Optional pytest tracing for unchanged native ownership tests; no runtime policy changes."""
import asyncio
import json
import time

import pytest


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    setattr(item, 'trace_report_' + report.when, report)


@pytest.fixture(autouse=True)
def trace_heartbeat(request, monkeypatch):
    selected = ('test_job_lease_recovery_fences_old_completion',
                'test_job_heartbeat_retries_transient_transport_failure')
    if not any(name in request.node.name for name in selected):
        yield
        return
    if 'adapters' not in request.fixturenames:
        yield
        return
    adapters = request.getfixturevalue('adapters')
    events = []
    lags = []
    started = time.monotonic()
    attached = set()
    def record(kind, **values):
        events.append({'t_ms': round((time.monotonic()-started)*1000, 3),
                       'wall_ms': int(time.time()*1000), 'kind': kind, **values})
    monitor = None
    for label, adapter in zip(('a', 'b'), adapters):
        def wrap(original, label=label, adapter=adapter):
            async def transition(method, *args):
                nonlocal monitor
                if monitor is None:
                    monitor = asyncio.create_task(observe_loop())
                before = time.monotonic()
                record('begin', owner=label, method=method)
                try:
                    result = await original(method, *args)
                    record('done', owner=label, method=method,
                           elapsed_ms=(time.monotonic()-before)*1000,
                           result=result.model_dump(mode='json') if hasattr(result, 'model_dump') else None)
                    pool = getattr(adapter, '_pool', None)
                    if pool:
                        for holder in pool._holders:
                            connection = holder._con
                            if connection is not None and id(connection) not in attached:
                                attached.add(id(connection))
                                def query(event, label=label):
                                    record('sql', owner=label, query=event.query[:120],
                                           elapsed_ms=event.elapsed*1000, error=repr(event.exception))
                                connection.add_query_logger(query)
                    return result
                except BaseException as error:
                    record('error', owner=label, method=method,
                           elapsed_ms=(time.monotonic()-before)*1000,
                           error=type(error).__name__, detail=str(error))
                    raise
            return transition
        monkeypatch.setattr(adapter, '_transition', wrap(adapter._transition))
    async def observe_loop():
        while True:
            before = time.monotonic()
            await asyncio.sleep(.01)
            lags.append(max(0, (time.monotonic()-before)*1000-10))
    try:
        yield
    finally:
        async def finalize():
            if monitor is not None:
                monitor.cancel()
                await asyncio.gather(monitor, return_exceptions=True)
            for label, adapter in zip(('a', 'b'), adapters):
                if not adapter._closed:
                    record('backend', owner=label, result=await adapter.health_probe())
        if monitor is not None:
            monitor.get_loop().run_until_complete(finalize())
        report = getattr(request.node, 'trace_report_call', None)
        print('HEARTBEAT_FULL_TRACE ' + json.dumps({
            'test': request.node.nodeid, 'failed': report.failed if report else None,
            'max_loop_lag_ms': max(lags, default=0), 'events': events}), flush=True)
