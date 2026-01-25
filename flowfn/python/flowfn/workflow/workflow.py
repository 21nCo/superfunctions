"""Workflow execution engine."""

from typing import Any, Optional
from flowfn.workflow.types import (
    WorkflowExecution,
    WorkflowEvent,
    ExecutionStatus,
    WorkflowContext,
    ListOptions
)
from flowfn.adapters.base import FlowAdapter
import asyncio
import uuid
import time


class Workflow:
    """Workflow execution engine."""
    
    def __init__(self, name: str, adapter: FlowAdapter, steps: list[dict[str, Any]]):
        self.name = name
        self._adapter = adapter
        self._steps = steps
        self._executions: dict[str, WorkflowExecution] = {}
        self._events: dict[str, list[WorkflowEvent]] = {}
        self._saga_stack: list[dict[str, Any]] = []
    
    async def execute(self, input_data: Any) -> WorkflowExecution:
        """Execute the workflow."""
        execution_id = str(uuid.uuid4())
        now = self._now()
        
        execution = WorkflowExecution(
            id=execution_id,
            workflow_id=self.name,
            input=input_data,
            status=ExecutionStatus.RUNNING,
            started_at=now,
            created_at=now,
            updated_at=now
        )
        
        self._executions[execution_id] = execution
        await self._adapter.save_workflow_state(execution_id, execution)
        
        # Log start event
        await self._log_event(execution_id, 'execution.started', {
            'workflow': self.name,
            'input': input_data
        })
        
        # Start execution in background
        asyncio.create_task(self._run_execution(execution))
        
        return execution
    
    async def _run_execution(self, execution: WorkflowExecution) -> None:
        """Run workflow execution."""
        context = WorkflowContext(execution.input, execution.context)
        
        try:
            # Execute all steps
            for step in self._steps:
                if execution.status == ExecutionStatus.CANCELLED:
                    break
                
                await self._execute_step(step, context, execution)
            
            # Mark as completed
            execution.status = ExecutionStatus.COMPLETED
            execution.completed_at = self._now()
            execution.updated_at = self._now()
            
            await self._log_event(execution.id, 'execution.completed', {
                'duration': execution.completed_at - execution.started_at
            })
        
        except Exception as error:
            # Run compensations if saga
            if self._saga_stack:
                await self._run_compensations(context)
            
            # Mark as failed
            execution.status = ExecutionStatus.FAILED
            execution.error = str(error)
            execution.completed_at = self._now()
            execution.updated_at = self._now()
            
            await self._log_event(execution.id, 'execution.failed', {
                'error': str(error)
            })
        
        finally:
            # Save final state
            await self._adapter.save_workflow_state(execution.id, execution)
    
    async def _execute_step(
        self,
        step: dict[str, Any],
        context: WorkflowContext,
        execution: WorkflowExecution
    ) -> None:
        """Execute a single step."""
        step_type = step['type']
        
        if step_type == 'step':
            await self._execute_regular_step(step, context, execution)
        
        elif step_type == 'parallel':
            await self._execute_parallel_steps(step, context, execution)
        
        elif step_type == 'branch':
            await self._execute_branch(step, context, execution)
        
        elif step_type == 'saga':
            await self._execute_saga(step, context, execution)
        
        elif step_type == 'delay':
            await self._execute_delay(step)
    
    async def _execute_regular_step(
        self,
        step: dict[str, Any],
        context: WorkflowContext,
        execution: WorkflowExecution
    ) -> None:
        """Execute a regular step."""
        step_name = step['name']
        handler = step['handler']
        
        await self._log_event(execution.id, 'step.started', {'step': step_name})
        
        await handler(context)
        
        # Update execution context
        execution.context = context.state
        execution.updated_at = self._now()
        await self._adapter.save_workflow_state(execution.id, execution)
        
        await self._log_event(execution.id, 'step.completed', {'step': step_name})
    
    async def _execute_parallel_steps(
        self,
        step: dict[str, Any],
        context: WorkflowContext,
        execution: WorkflowExecution
    ) -> None:
        """Execute parallel steps."""
        handlers = step['steps']
        
        await self._log_event(execution.id, 'parallel.started', {
            'count': len(handlers)
        })
        
        # Run all in parallel
        await asyncio.gather(*[handler(context) for handler in handlers])
        
        await self._log_event(execution.id, 'parallel.completed', {
            'count': len(handlers)
        })
    
    async def _execute_branch(
        self,
        step: dict[str, Any],
        context: WorkflowContext,
        execution: WorkflowExecution
    ) -> None:
        """Execute conditional branch."""
        condition = step['condition']
        then_workflow = step.get('then')
        else_workflow = step.get('else')
        
        if condition(context):
            if then_workflow:
                for then_step in then_workflow._steps:
                    await self._execute_step(then_step, context, execution)
        else:
            if else_workflow:
                for else_step in else_workflow._steps:
                    await self._execute_step(else_step, context, execution)
    
    async def _execute_saga(
        self,
        step: dict[str, Any],
        context: WorkflowContext,
        execution: WorkflowExecution
    ) -> None:
        """Execute saga step."""
        saga_name = step['name']
        execute_handler = step['execute']
        compensate_handler = step['compensate']
        
        await self._log_event(execution.id, 'saga.started', {'saga': saga_name})
        
        # Add to saga stack
        self._saga_stack.append({
            'name': saga_name,
            'compensate': compensate_handler
        })
        
        # Execute
        await execute_handler(context)
        
        await self._log_event(execution.id, 'saga.completed', {'saga': saga_name})
    
    async def _execute_delay(self, step: dict[str, Any]) -> None:
        """Execute delay step."""
        duration = step['duration']
        await asyncio.sleep(duration / 1000.0)
    
    async def _run_compensations(self, context: WorkflowContext) -> None:
        """Run saga compensations in reverse order."""
        while self._saga_stack:
            saga = self._saga_stack.pop()
            try:
                await saga['compensate'](context)
            except Exception as error:
                print(f"Compensation failed for {saga['name']}: {error}")
    
    async def get_execution(self, execution_id: str) -> WorkflowExecution:
        """Get execution by ID."""
        # Check local cache first
        if execution_id in self._executions:
            return self._executions[execution_id]
        
        # Load from adapter
        execution = await self._adapter.load_workflow_state(execution_id)
        if not execution:
            raise ValueError(f"Execution not found: {execution_id}")
        
        return execution
    
    async def list_executions(
        self,
        opts: Optional[ListOptions] = None
    ) -> list[WorkflowExecution]:
        """List executions."""
        options = opts or ListOptions()
        
        executions = list(self._executions.values())
        
        # Filter by status
        if options.status:
            executions = [e for e in executions if e.status == options.status]
        
        # Sort by created time (newest first)
        executions.sort(key=lambda e: e.created_at, reverse=True)
        
        # Apply limit and offset
        start = options.offset
        end = start + options.limit
        return executions[start:end]
    
    async def cancel_execution(self, execution_id: str) -> None:
        """Cancel a running execution."""
        execution = await self.get_execution(execution_id)
        
        if execution.status not in [ExecutionStatus.COMPLETED, ExecutionStatus.FAILED]:
            execution.status = ExecutionStatus.CANCELLED
            execution.completed_at = self._now()
            execution.updated_at = self._now()
            
            await self._adapter.save_workflow_state(execution_id, execution)
            await self._log_event(execution_id, 'execution.cancelled', {})
    
    async def retry_execution(self, execution_id: str) -> WorkflowExecution:
        """Retry a failed execution."""
        old_execution = await self.get_execution(execution_id)
        
        if old_execution.status != ExecutionStatus.FAILED:
            raise ValueError("Can only retry failed executions")
        
        # Create new execution with same input
        return await self.execute(old_execution.input)
    
    async def get_execution_history(
        self,
        execution_id: str
    ) -> list[WorkflowEvent]:
        """Get execution event history."""
        return self._events.get(execution_id, [])
    
    async def get_metrics(self) -> dict[str, Any]:
        """Get workflow metrics."""
        executions = list(self._executions.values())
        
        total = len(executions)
        completed = len([e for e in executions if e.status == ExecutionStatus.COMPLETED])
        failed = len([e for e in executions if e.status == ExecutionStatus.FAILED])
        
        # Calculate average duration
        durations = [
            e.completed_at - e.started_at
            for e in executions
            if e.completed_at is not None
        ]
        avg_duration = sum(durations) / len(durations) if durations else 0
        
        return {
            'totalExecutions': total,
            'running': len([e for e in executions if e.status == ExecutionStatus.RUNNING]),
            'completed': completed,
            'failed': failed,
            'successRate': (completed / total * 100) if total > 0 else 0,
            'avgDuration': avg_duration
        }
    
    async def _log_event(
        self,
        execution_id: str,
        event_type: str,
        data: Optional[dict[str, Any]] = None
    ) -> None:
        """Log workflow event."""
        if execution_id not in self._events:
            self._events[execution_id] = []
        
        event = WorkflowEvent(
            id=str(uuid.uuid4()),
            execution_id=execution_id,
            type=event_type,
            timestamp=self._now(),
            data=data
        )
        
        self._events[execution_id].append(event)
    
    def _now(self) -> int:
        """Get current timestamp in ms."""
        return int(time.time() * 1000)
