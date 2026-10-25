from watchfn import WatchFn


def test_disabled_tracing_does_not_record():
    watch = WatchFn('disabled', trace_enabled=False)
    watch.system_metrics.start = lambda: None
    watch.process_metrics.start = lambda: None
    watch.start()
    try:
        watch.trace.start_span('ignored').finish(); watch.batcher.flush()
        assert watch.trace.query({}) == []
    finally:
        watch.stop()

import json
from pathlib import Path
import pytest
from watchfn.trace.sampling import sample_trace
from watchfn.trace.tracer import Tracer
from watchfn.trace.context_propagation import trace_context_propagator

vectors = json.loads((Path(__file__).parent / 'fixtures/trace-sampling-golden.json').read_text())


@pytest.mark.parametrize('vector', vectors)
def test_shared_root_decisions(vector):
    assert sample_trace(vector['id'], vector['rate']) == vector['sampled']


def test_nested_parent_decision_and_configured_service():
    events = []
    tracer = Tracer('service', lambda _name, span: events.append(span), sample_rate=0)
    with tracer.trace('root') as root:
        with tracer.trace('child') as child:
            assert root.trace_flags == child.trace_flags == 0
            assert tracer.inject_headers()['traceparent'].endswith('-00')
    assert not events and not tracer.active_spans
    parent = trace_context_propagator.create()
    with tracer.with_headers('inbound', trace_context_propagator.inject(parent)) as span:
        assert span.trace_flags == 1
    assert len(events) == 1
    disabled = Tracer('off', lambda *_: pytest.fail('must not record'), enabled=False)
    with disabled.with_headers('off', trace_context_propagator.inject(parent)) as span:
        assert span.trace_flags == 0
    watch = WatchFn('app', trace={'sampleRate': 1, 'serviceName': 'trace-service'})
    assert watch.trace.service_name == 'trace-service'
    assert WatchFn('default').trace.sample_rate == 1
    assert WatchFn('configured', trace={}).trace.sample_rate == .1


def test_invalid_sampling_configuration():
    for rate in [float('nan'), float('inf'), -1, 1.1, True, '0.5']:
        with pytest.raises(ValueError): sample_trace('id', rate)
        with pytest.raises(ValueError): WatchFn('invalid', trace={'sampleRate': rate})
    with pytest.raises(ValueError, match='Unicode'): sample_trace('\ud800', 1)


def test_configured_service_is_stored_and_zero_rate_can_follow_parent():
    watch = WatchFn('app', trace={'sampleRate': 0, 'serviceName': 'trace-service'})
    watch.system_metrics.start = lambda: None
    watch.process_metrics.start = lambda: None
    watch.start()
    try:
        watch.trace.start_span('omitted').finish(); watch.batcher.flush()
        assert watch.trace.query({}) == []
        with watch.trace.with_headers('kept', trace_context_propagator.inject(trace_context_propagator.create())):
            pass
        watch.batcher.flush()
        assert [span['service'] for span in watch.trace.query({})] == ['trace-service']
    finally:
        watch.stop()
