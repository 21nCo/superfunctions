"""Integration tests for FlowFn Python SDK."""

import pytest
import asyncio
from flowfn import create_flow


@pytest.mark.asyncio
async def test_queue_to_stream_integration():
    """Test queue processing publishing to stream."""
    flow = create_flow(adapter='memory')
    
    queue = flow.queue('processing')
    stream = flow.stream('events')
    
    received = []
    
    @stream.subscribe()
    async def handle_event(msg):
        received.append(msg.data)
        await msg.ack()
    
    @queue.process()
    async def process_job(job):
        await stream.publish({'processed': job.data})
        return {'success': True}
    
    # Add jobs
    await queue.add('task', {'value': 1})
    await queue.add('task', {'value': 2})
    
    await asyncio.sleep(0.5)
    
    assert len(received) >= 1
    
    await flow.close()


@pytest.mark.asyncio
async def test_queue_to_workflow_integration():
    """Test queue triggering workflows."""
    flow = create_flow(adapter='memory')
    
    queue = flow.queue('triggers')
    executed = [False]
    
    async def validate(ctx):
        ctx.set('validated', True)
    
    async def execute(ctx):
        executed[0] = True
    
    workflow = (
        flow.workflow('process-order')
        .step('validate', validate)
        .step('execute', execute)
        .build()
    )
    
    @queue.process()
    async def process_trigger(job):
        await workflow.execute(job.data)
        return {'done': True}
    
    await queue.add('order', {'orderId': '123'})
    await asyncio.sleep(0.3)
    
    assert executed[0] is True
    
    await flow.close()


@pytest.mark.asyncio
async def test_complete_e2e_flow():
    """Test complete queue → workflow → stream flow."""
    flow = create_flow(adapter='memory')
    
    queue = flow.queue('orders')
    stream = flow.stream('order-events')
    
    events = []
    
    @stream.subscribe()
    async def track_events(msg):
        events.append(msg.data['status'])
        await msg.ack()
    
    async def validate(ctx):
        await stream.publish({'status': 'validating', 'order': ctx.input})
    
    async def process(ctx):
        await stream.publish({'status': 'processing', 'order': ctx.input})
    
    async def complete(ctx):
        await stream.publish({'status': 'completed', 'order': ctx.input})
    
    workflow = (
        flow.workflow('order-processing')
        .step('validate', validate)
        .step('process', process)
        .step('complete', complete)
        .build()
    )
    
    @queue.process()
    async def process_order(job):
        await workflow.execute(job.data)
        return {'success': True}
    
    await queue.add('new-order', {'id': 'order-123', 'amount': 100})
    await asyncio.sleep(0.5)
    
    assert 'validating' in events
    assert 'processing' in events
    assert 'completed' in events
    
    await flow.close()


@pytest.mark.asyncio
async def test_concurrent_operations():
    """Test multiple queues and streams concurrently."""
    flow = create_flow(adapter='memory')
    
    queue1 = flow.queue('concurrent-1')
    queue2 = flow.queue('concurrent-2')
    
    count1, count2 = [0], [0]
    
    @queue1.process()
    async def proc1(job):
        count1[0] += 1
    
    @queue2.process()
    async def proc2(job):
        count2[0] += 1
    
    await asyncio.gather(
        queue1.add('job', {'id': 1}),
        queue1.add('job', {'id': 2}),
        queue2.add('job', {'id': 3}),
        queue2.add('job', {'id': 4}),
    )
    
    await asyncio.sleep(0.3)
    
    assert count1[0] == 2
    assert count2[0] == 2
    
    await flow.close()


@pytest.mark.asyncio
async def test_health_and_metrics():
    """Test health checks and metrics collection."""
    flow = create_flow(adapter='memory')
    
    # Record metrics
    flow.metrics.record('test', 10.5, {'env': 'test'})
    flow.metrics.record('test', 20.3, {'env': 'test'})
    
    # Check metrics
    series = flow.metrics.get_time_series('test', tags={'env': 'test'})
    assert series is not None
    assert series.count == 2
    
    # Health check
    health = await flow.health_check()
    assert health['healthy'] is True
    assert len(health['checks']) > 0
    
    # Event tracking
    tracker = flow.get_event_tracker()
    tracker.track({
        'type': 'test.event',
        'category': 'system',
        'severity': 'info',
        'message': 'Test event'
    })
    
    events = tracker.get_events({'type': 'test.event'})
    assert len(events) == 1
    
    await flow.close()


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
