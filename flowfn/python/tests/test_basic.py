"""Basic tests for FlowFn Python SDK."""

import pytest
import asyncio
from flowfn import create_flow


@pytest.mark.asyncio
async def test_create_flow():
    """Test creating a FlowFn instance."""
    flow = create_flow(adapter='memory')
    
    assert flow is not None
    assert flow.config.adapter == 'memory'
    
    await flow.close()


@pytest.mark.asyncio
async def test_queue_basic():
    """Test basic queue operations."""
    flow = create_flow(adapter='memory')
    queue = flow.queue('test-queue')
    
    # Add a job
    job = await queue.add('test-job', {'value': 123})
    
    assert job.name == 'test-job'
    assert job.data['value'] == 123
    assert job.id is not None
    
    # Get job counts
    stats = await queue.get_job_counts()
    assert stats.waiting >= 1
    
    await flow.close()


@pytest.mark.asyncio
async def test_queue_processing():
    """Test queue job processing."""
    flow = create_flow(adapter='memory')
    queue = flow.queue('process-queue')
    
    processed = []
    
    @queue.process()
    async def process_job(job):
        processed.append(job.data)
        return {'result': 'success'}
    
    # Add jobs
    await queue.add('job1', {'id': 1})
    await queue.add('job2', {'id': 2})
    
    # Wait for processing
    await asyncio.sleep(0.5)
    
    assert len(processed) >= 1
    
    await flow.close()


@pytest.mark.asyncio
async def test_stream_publish_subscribe():
    """Test stream pub/sub."""
    flow = create_flow(adapter='memory')
    stream = flow.stream('test-stream')
    
    received = []
    
    @stream.subscribe()
    async def handle_message(message):
        received.append(message.data)
        await message.ack()
    
    # Publish messages
    await stream.publish({'value': 'hello'})
    await stream.publish({'value': 'world'})
    
    # Wait for delivery
    await asyncio.sleep(0.2)
    
    assert len(received) >= 1
    
    await flow.close()


@pytest.mark.asyncio
async def test_health_check():
    """Test health check."""
    flow = create_flow(adapter='memory')
    
    health = await flow.health_check()
    
    assert health['healthy'] is True
    assert len(health['checks']) > 0
    assert health['timestamp'] > 0
    
    await flow.close()


@pytest.mark.asyncio
async def test_metrics():
    """Test metrics recording."""
    flow = create_flow(adapter='memory')
    
    # Record metrics
    flow.metrics.record('test.metric', 10.5, {'tag': 'value'})
    flow.metrics.record('test.metric', 20.3, {'tag': 'value'})
    
    # Get time series
    series = flow.metrics.get_time_series('test.metric', tags={'tag': 'value'})
    
    assert series is not None
    assert series.count == 2
    assert series.avg > 0
    
    await flow.close()


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
