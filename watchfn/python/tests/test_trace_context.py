import json
from pathlib import Path
import pytest
from dataclasses import replace
from watchfn.trace.context_propagation import TraceContextPropagator

cases = json.loads((Path(__file__).parent / 'fixtures/trace-context-golden.json').read_text())


@pytest.mark.parametrize('case', cases, ids=lambda case: case['name'])
def test_shared_wire_vectors(case):
    propagator = TraceContextPropagator()
    context = propagator.extract(case['headers'])
    assert (context is not None) == case['valid']
    if context:
        assert context.trace_state == case.get('state')
        assert context.trace_flags == 1
        output = propagator.inject(context, {'TraceParent': 'stale', 'TraceState': 'stale', 'other': 'retained'})
        assert output['other'] == 'retained' and 'TraceParent' not in output and 'TraceState' not in output
        assert propagator.extract(output) == context


def test_atomic_injection_and_child_identity():
    propagator = TraceContextPropagator()
    parent = propagator.create(); child = propagator.create_child(parent)
    assert child.trace_id == parent.trace_id and child.parent_span_id == parent.span_id and child.span_id != parent.span_id
    headers = {'TraceParent': 'keep'}
    for context in [replace(parent, trace_id=parent.trace_id+'\n'), replace(parent, trace_flags=True), replace(parent, trace_state='vendor=value\r\ninjected=yes')]:
        with pytest.raises(ValueError): propagator.inject(context, headers)
    assert headers == {'TraceParent': 'keep'}


@pytest.mark.asyncio
async def test_async_parenting_propagation_and_completed_context_isolation():
    import asyncio
    from watchfn.trace.tracer import Tracer
    events = []
    tracer = Tracer('api', lambda _name, span: events.append(span))
    propagator = TraceContextPropagator()
    async def request(flag):
        parent = propagator.create(); parent.trace_flags = flag; parent.trace_state = f'vendor=value{flag}'
        with tracer.with_headers('request', propagator.inject(parent)) as root:
            await asyncio.sleep(0)
            with tracer.trace('child') as child:
                await asyncio.sleep(0)
                headers = tracer.inject_headers()
                assert child.parent_span_id == root.span_id and child.trace_id == root.trace_id == parent.trace_id
                context = propagator.extract(headers)
                assert context.span_id == child.span_id and context.trace_flags == flag and context.trace_state == parent.trace_state
            assert propagator.extract(tracer.inject_headers()).span_id == root.span_id
            separate = tracer.start_span('separate', trace_id='separate'); separate.finish()
            assert separate.parent_span_id is None
    await asyncio.gather(request(0), request(1))
    with pytest.raises(RuntimeError, match='No active'): tracer.inject_headers()
    gate = asyncio.Event()
    with tracer.trace('finished') as root:
        async def later():
            await gate.wait()
            span = tracer.start_span('late'); span.finish(); return span
        task = asyncio.create_task(later())
    gate.set(); late = await task
    assert late.trace_id != root.trace_id and late.parent_span_id is None


def test_invalid_inbound_context_starts_independent_trace_and_restores_parent():
    from watchfn.trace.tracer import Tracer
    tracer = Tracer('api', lambda *_: None)
    with tracer.trace('outer') as outer:
        with tracer.with_headers('invalid', {'traceparent': 'broken'}) as inner:
            assert inner.trace_id != outer.trace_id and inner.parent_span_id is None
        assert TraceContextPropagator().extract(tracer.inject_headers()).span_id == outer.span_id


@pytest.mark.asyncio
async def test_cancelled_async_scope_records_error_and_releases_context():
    import asyncio
    from watchfn.trace.tracer import Tracer
    events = []
    tracer = Tracer('api', lambda _name, span: events.append(span))
    for manager in [tracer.trace('cancelled'), tracer.with_headers('cancelled-inbound', {})]:
        with pytest.raises(asyncio.CancelledError):
            with manager:
                await asyncio.sleep(0)
                raise asyncio.CancelledError()
        with pytest.raises(RuntimeError, match='No active'): tracer.inject_headers()
    assert len(events) == 2 and all(span['tags']['error'] is True for span in events)
    assert not tracer.active_spans


def test_repeated_fields_stop_at_bounds_before_join():
    propagator = TraceContextPropagator()
    parent = propagator.inject(propagator.create())['traceparent']
    class Parents(list):
        def __iter__(self):
            yield parent; yield parent
            raise AssertionError('read past duplicate parent')
    class States(list):
        def __iter__(self):
            yield 'x' * 513
            raise AssertionError('read past state bound')
    assert propagator.extract({'traceparent': Parents()}) is None
    assert propagator.extract({'traceparent': parent, 'tracestate': States()}).trace_state is None
