"""Workflow storage abstraction."""

from typing import Optional, Protocol
from flowfn.workflow.types import WorkflowExecution, ExecutionStatus, ListOptions


class WorkflowStorage(Protocol):
    """Workflow storage interface."""
    
    async def save(self, workflow_id: str, execution: WorkflowExecution) -> None:
        """Save workflow execution."""
        ...
    
    async def get(self, execution_id: str) -> Optional[WorkflowExecution]:
        """Get execution by ID."""
        ...
    
    async def list(
        self,
        workflow_id: str,
        opts: Optional[ListOptions] = None
    ) -> list[WorkflowExecution]:
        """List executions for a workflow."""
        ...
    
    async def update_status(
        self,
        execution_id: str,
        status: ExecutionStatus
    ) -> None:
        """Update execution status."""
        ...
    
    async def delete(self, execution_id: str) -> None:
        """Delete an execution."""
        ...


class MemoryWorkflowStorage:
    """In-memory workflow storage."""
    
    def __init__(self) -> None:
        self._executions: dict[str, WorkflowExecution] = {}
        self._by_workflow: dict[str, list[str]] = {}
    
    async def save(self, workflow_id: str, execution: WorkflowExecution) -> None:
        """Save workflow execution."""
        self._executions[execution.id] = execution
        
        if workflow_id not in self._by_workflow:
            self._by_workflow[workflow_id] = []
        
        if execution.id not in self._by_workflow[workflow_id]:
            self._by_workflow[workflow_id].append(execution.id)
    
    async def get(self, execution_id: str) -> Optional[WorkflowExecution]:
        """Get execution by ID."""
        return self._executions.get(execution_id)
    
    async def list(
        self,
        workflow_id: str,
        opts: Optional[ListOptions] = None
    ) -> list[WorkflowExecution]:
        """List executions for a workflow."""
        options = opts or ListOptions()
        
        execution_ids = self._by_workflow.get(workflow_id, [])
        executions = [
            self._executions[eid]
            for eid in execution_ids
            if eid in self._executions
        ]
        
        # Filter by status
        if options.status:
            executions = [e for e in executions if e.status == options.status]
        
        # Sort by created time
        executions.sort(key=lambda e: e.created_at, reverse=True)
        
        # Apply pagination
        start = options.offset
        end = start + options.limit
        return executions[start:end]
    
    async def update_status(
        self,
        execution_id: str,
        status: ExecutionStatus
    ) -> None:
        """Update execution status."""
        if execution_id in self._executions:
            self._executions[execution_id].status = status
    
    async def delete(self, execution_id: str) -> None:
        """Delete an execution."""
        if execution_id in self._executions:
            execution = self._executions[execution_id]
            workflow_id = execution.workflow_id
            
            # Remove from main storage
            del self._executions[execution_id]
            
            # Remove from workflow index
            if workflow_id in self._by_workflow:
                self._by_workflow[workflow_id].remove(execution_id)
    
    def clear(self) -> None:
        """Clear all executions."""
        self._executions.clear()
        self._by_workflow.clear()
