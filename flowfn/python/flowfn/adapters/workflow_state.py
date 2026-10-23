"""Storage-independent workflow ownership transitions."""
import uuid
from typing import Any, Optional

from flowfn.workflow.types import ExecutionStatus, WorkflowExecution


class WorkflowLeaseError(RuntimeError):
    """The workflow execution is owned by another worker or its lease expired."""


def transition(current: Optional[WorkflowExecution], operation: str, payload: dict[str, Any], now: int) -> Optional[WorkflowExecution]:
    if operation == 'create':
        if current is not None:
            return current
        created: WorkflowExecution = payload['execution']
        return created.model_copy(deep=True)
    if operation == 'save':
        incoming: WorkflowExecution = payload['execution']
        if current is not None and current.lease_token is not None:
            if incoming.lease_token != current.lease_token or (current.lease_expires_at or 0) <= now:
                raise WorkflowLeaseError('Workflow lease expired or ownership changed')
            incoming = incoming.model_copy(deep=True)
            incoming.lease_expires_at = current.lease_expires_at
            if incoming.workflow_id == '__scheduler__':
                incoming.state['paused'] = current.state.get('paused', False)
        elif incoming.lease_token is not None:
            raise WorkflowLeaseError('Workflow lease no longer exists')
        return incoming.model_copy(deep=True)
    if current is None:
        return None
    if operation == 'schedule_control':
        if current.workflow_id != '__scheduler__':
            raise ValueError('Not a scheduler record')
        current.state['paused'] = payload['paused']
        return current
    if operation == 'release':
        if current.lease_token != payload['token']:
            return None
        current.lease_token = None
        current.lease_expires_at = None
        return current
    if operation == 'claim':
        if current.workflow_id != payload['workflow_id'] or current.definition_version != payload['version'] or current.definition_hash != payload['definition_hash']:
            raise ValueError('Workflow definition does not match persisted execution')
        if current.status != ExecutionStatus.RUNNING or (current.lease_token is not None and (current.lease_expires_at or 0) > now):
            return None
        current.lease_token = uuid.uuid4().hex
        current.lease_expires_at = now + payload['lease_ms']
        return current
    if operation == 'renew':
        if current.lease_token != payload['token'] or current.status != ExecutionStatus.RUNNING or (current.lease_expires_at or 0) <= now:
            return None
        current.lease_expires_at = now + payload['lease_ms']
        return current
    if operation in ('cancel','cancel_owned'):
        if current.workflow_id != payload['workflow_id']:
            raise ValueError('Execution belongs to another workflow')
        if operation == 'cancel_owned' and (payload.get('token') is None or current.lease_token != payload['token'] or (current.lease_expires_at or 0) <= now):
            return None
        if current.status == ExecutionStatus.RUNNING:
            current.status = ExecutionStatus.CANCELLED
            current.completed_at = now
            current.updated_at = now
            current.lease_token = None
            current.lease_expires_at = None
        return current
    raise ValueError('Unknown workflow transition')
