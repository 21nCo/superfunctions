"""Workflow tests."""

import pytest
import asyncio
from flowfn import create_flow


@pytest.mark.asyncio
async def test_workflow_basic():
    """Test basic workflow execution."""
    flow = create_flow(adapter='memory')
    
    steps_executed = []
    
    async def step1(ctx):
        steps_executed.append('step1')
        ctx.set('value', 10)
    
    async def step2(ctx):
        steps_executed.append('step2')
        value = ctx.get('value')
        ctx.set('doubled', value * 2)
    
    workflow = (
        flow.workflow('test-workflow')
        .step('step1', step1)
        .step('step2', step2)
        .build()
    )
    
    execution = await workflow.execute({'input': 'test'})
    
    assert execution.id is not None
    assert execution.status.value == 'running'
    
    # Wait for completion
    await asyncio.sleep(0.5)
    
    result = await workflow.get_execution(execution.id)
    assert result.status.value == 'completed'
    assert len(steps_executed) == 2
    
    await flow.close()


@pytest.mark.asyncio
async def test_workflow_parallel():
    """Test parallel workflow execution."""
    flow = create_flow(adapter='memory')
    
    executed = []
    
    async def task1(ctx):
        executed.append(1)
    
    async def task2(ctx):
        executed.append(2)
    
    async def task3(ctx):
        executed.append(3)
    
    workflow = (
        flow.workflow('parallel-workflow')
        .parallel([task1, task2, task3])
        .build()
    )
    
    execution = await workflow.execute({})
    await asyncio.sleep(0.3)
    
    result = await workflow.get_execution(execution.id)
    assert result.status.value == 'completed'
    assert len(executed) == 3
    
    await flow.close()


@pytest.mark.asyncio
async def test_workflow_cancel():
    """Test workflow cancellation."""
    flow = create_flow(adapter='memory')
    
    async def long_step(ctx):
        await asyncio.sleep(10)
    
    workflow = (
        flow.workflow('cancel-workflow')
        .step('long', long_step)
        .build()
    )
    
    execution = await workflow.execute({})
    await asyncio.sleep(0.1)
    
    # Cancel it
    await workflow.cancel_execution(execution.id)
    
    result = await workflow.get_execution(execution.id)
    assert result.status.value == 'cancelled'
    
    await flow.close()


@pytest.mark.asyncio
async def test_workflow_retry():
    """Test workflow retry."""
    flow = create_flow(adapter='memory')
    
    attempt = [0]
    
    async def failing_step(ctx):
        attempt[0] += 1
        if attempt[0] == 1:
            raise Exception('First attempt fails')
    
    workflow = (
        flow.workflow('retry-workflow')
        .step('failing', failing_step)
        .build()
    )
    
    execution = await workflow.execute({})
    await asyncio.sleep(0.2)
    
    # Should fail
    result = await workflow.get_execution(execution.id)
    assert result.status.value == 'failed'
    
    # Retry
    retried = await workflow.retry_execution(execution.id)
    await asyncio.sleep(0.2)
    
    retried_result = await workflow.get_execution(retried.id)
    assert retried_result.status.value == 'completed'
    assert attempt[0] == 2
    
    await flow.close()


@pytest.mark.asyncio
async def test_workflow_metrics():
    """Test workflow metrics."""
    flow = create_flow(adapter='memory')
    
    async def simple_step(ctx):
        pass
    
    workflow = (
        flow.workflow('metrics-workflow')
        .step('work', simple_step)
        .build()
    )
    
    # Execute multiple times
    await workflow.execute({'id': 1})
    await workflow.execute({'id': 2})
    
    await asyncio.sleep(0.3)
    
    metrics = await workflow.get_metrics()
    
    assert metrics['totalExecutions'] == 2
    assert metrics['completed'] >= 0
    assert metrics['avgDuration'] >= 0
    
    await flow.close()


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
