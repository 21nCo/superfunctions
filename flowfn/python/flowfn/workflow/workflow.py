"""Workflow execution engine."""

from typing import Any, Optional
from flowfn.workflow.types import (
    WorkflowExecution,
    WorkflowEvent,
    ExecutionStatus,
    WorkflowContext,
    ListOptions,
)
from flowfn.adapters.base import FlowAdapter
import asyncio
from flowfn.core.lifecycle import Admissions
from flowfn.core.telemetry import OperationObserver
from flowfn.monitoring.health import EventTracker
import uuid
import time
import hashlib
import json
from copy import copy
from flowfn.adapters.workflow_state import WorkflowLeaseError


class Workflow:
    """Workflow execution engine."""

    def __init__(self, name: str, adapter: FlowAdapter, steps: list[dict[str, Any]], *, version: str = "1", lease_ms: int = 30000):
        if not version or lease_ms < 100:
            raise ValueError("Nonempty version and lease >= 100 milliseconds required")
        self._observer = OperationObserver()
        self._events: Optional[EventTracker] = None
        self.name = name
        self._adapter = adapter
        def freeze(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
            frozen = []
            for original in items:
                item = dict(original)
                if item['type'] == 'parallel':
                    item['steps'] = list(item['steps'])
                if item['type'] == 'branch':
                    for direction in ('then','else'):
                        if item.get(direction) is not None:
                            nested = copy(item[direction])
                            nested._steps = freeze(nested._steps)
                            item[direction] = nested
                frozen.append(item)
            return frozen
        self._steps = freeze(steps)
        self._executions: dict[str, WorkflowExecution] = {}
        self._saga_stacks: dict[str, list[dict[str, Any]]] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._closed = False
        self._admissions = Admissions(lambda: self._closed)
        self.version = version
        self.lease_ms = lease_ms
        self._lease_lost: set[str] = set()
        self._lease_deadlines: dict[str, float] = {}
        self._state_locks: dict[str, asyncio.Lock] = {}
        self._heartbeats: dict[str, asyncio.Task[None]] = {}
        self._sagas: dict[str, dict[str, Any]] = {}

        def describe(steps: list[dict[str, Any]], prefix: str = "") -> list[Any]:
            result = []
            for index, step in enumerate(steps):
                path = f"{prefix}/{index}"
                item = {key: value for key, value in step.items() if key in ("type", "name", "duration")}
                if step["type"] == "parallel":
                    item["count"] = len(step["steps"])
                if step["type"] == "saga":
                    self._sagas[path] = step
                if step["type"] == "branch":
                    for branch in ("then", "else"):
                        nested = step.get(branch)
                        item[branch] = describe(nested._steps, path + "/" + branch) if nested else []
                result.append(item)
            return result

        self.definition_hash = hashlib.sha256(json.dumps(describe(self._steps),sort_keys=True).encode()).hexdigest()

    async def execute(self, input_data: Any) -> WorkflowExecution:
        """Execute the workflow."""
        async with self._admissions.track():
            if self._closed:
                raise RuntimeError("Workflow is closed")
            execution_id = str(uuid.uuid4())
            now = self._now()

            execution = WorkflowExecution(
                id=execution_id,
                workflow_id=self.name,
                input=input_data,
                definition_version=self.version,
                definition_hash=self.definition_hash,
                status=ExecutionStatus.RUNNING,
                started_at=now,
                created_at=now,
                updated_at=now,
            )

            self._executions[execution_id] = execution
            await self._persist(execution)
            execution = await self._claim(execution_id)
            self._executions[execution_id] = execution

            # Log start event
            await self._log_event(
                execution_id, "execution.started", {"workflow": self.name, "input": input_data}
            )

            if self._closed:
                await self._cancel_owned(execution_id)
            else:
                self._start(execution)
            return execution

    async def _claim(self, execution_id: str) -> WorkflowExecution:
        requested = time.monotonic()
        claimed = await self._adapter.transition_workflow_state(execution_id, "claim", {
            "workflow_id": self.name, "version": self.version,
            "definition_hash": self.definition_hash, "lease_ms": self.lease_ms,
        })
        if claimed is None:
            raise WorkflowLeaseError("Execution missing, terminal, or owned by another worker")
        deadline = requested + self.lease_ms / 1000
        if time.monotonic() >= deadline:
            raise WorkflowLeaseError("Workflow claim reply arrived after its local lease deadline")
        self._lease_deadlines[execution_id] = deadline
        return claimed

    async def resume_execution(self, execution_id: str) -> WorkflowExecution:
        """Claim an abandoned execution and resume its incomplete steps."""
        async with self._admissions.track():
            if self._closed:
                raise RuntimeError("Workflow is closed")
            if execution_id in self._tasks and not self._tasks[execution_id].done():
                raise WorkflowLeaseError("Execution already has an active local runtime")
            execution = await self._claim(execution_id)
            self._executions[execution_id] = execution
            await self._log_event(execution_id, "execution.resumed", {})
            if self._closed:
                await self._cancel_owned(execution_id)
            else:
                self._start(execution)
            return execution

    def _start(self, execution: WorkflowExecution) -> None:
        execution_id = execution.id
        if time.monotonic() >= self._lease_deadlines[execution_id]:
            raise WorkflowLeaseError("Workflow lease expired before handler startup")
        self._lease_lost.discard(execution_id)
        self._saga_stacks[execution_id] = [dict(self._sagas[path], path=path) for path in execution.state.get("sagas", [])]
        task = asyncio.create_task(self._run_execution(execution))
        self._tasks[execution_id] = task
        heartbeat = asyncio.create_task(self._renew(execution))
        self._heartbeats[execution_id] = heartbeat

        def finished(done: asyncio.Task[None]) -> None:
            heartbeat.cancel()
            if self._tasks.get(execution_id) is done:
                self._heartbeats.pop(execution_id, None)
                self._tasks.pop(execution_id, None)
                self._saga_stacks.pop(execution_id, None)
                self._lease_deadlines.pop(execution_id, None)
            if not done.cancelled() and done.exception() is not None:
                done.get_loop().call_exception_handler({"message": "Workflow execution failed", "exception": done.exception(), "task": done})

        task.add_done_callback(finished)

    async def _renew(self, execution: WorkflowExecution) -> None:
        duration = self.lease_ms / 1000
        delay = duration / 3
        deadline = self._lease_deadlines[execution.id]
        while execution.status == ExecutionStatus.RUNNING:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            await asyncio.sleep(min(delay,remaining))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            requested = time.monotonic()
            try:
                renewed = await asyncio.wait_for(self._adapter.transition_workflow_state(
                    execution.id,"renew",{"token":execution.lease_token,"lease_ms":self.lease_ms}),remaining)
            except Exception:
                delay = min(.05,duration / 6)
                continue
            if renewed is None:
                break
            deadline = requested + duration
            self._lease_deadlines[execution.id] = deadline
            delay = duration / 3
        if execution.status == ExecutionStatus.RUNNING:
            self._lease_lost.add(execution.id)
            task = self._tasks.get(execution.id)
            if task is not None:
                task.cancel()

    async def _persist(self, execution: WorkflowExecution) -> None:
        async with self._state_locks.setdefault(execution.id, asyncio.Lock()):
            await self._adapter.save_workflow_state(execution.id, execution)

    async def _run_execution(self, execution: WorkflowExecution) -> None:
        """Run workflow execution."""
        context = WorkflowContext(execution.input, execution.context)

        try:
            if execution.state.get("compensating"):
                await self._run_compensations(context, execution.id)
                execution.status = ExecutionStatus.FAILED
                execution.completed_at = self._now()
                await self._log_event(execution.id, "execution.failed", {"error": execution.error})
                return
            # Execute all steps
            for index, step in enumerate(self._steps):
                if execution.status == ExecutionStatus.CANCELLED:
                    break

                await self._execute_step(step, context, execution, f"/{index}")

            if execution.status == ExecutionStatus.CANCELLED:
                return

            # Mark as completed
            execution.status = ExecutionStatus.COMPLETED
            execution.completed_at = self._now()
            execution.updated_at = self._now()

            await self._log_event(
                execution.id,
                "execution.completed",
                {"duration": execution.completed_at - execution.started_at},
            )

        except WorkflowLeaseError:
            self._lease_lost.add(execution.id)
            raise

        except asyncio.CancelledError:
            if execution.id in self._lease_lost:
                raise
            execution.status = ExecutionStatus.CANCELLED
            execution.completed_at = self._now()
            execution.updated_at = self._now()
            raise

        except Exception as error:
            if execution.status == ExecutionStatus.CANCELLED:
                return
            execution.error = str(error)
            execution.state["compensating"] = True
            await self._persist(execution)
            # Compensate only this execution.
            await self._run_compensations(context, execution.id)

            # Mark as failed
            execution.status = ExecutionStatus.FAILED
            execution.error = str(error)
            execution.completed_at = self._now()
            execution.updated_at = self._now()

            await self._log_event(execution.id, "execution.failed", {"error": str(error)})

        finally:
            self._saga_stacks.pop(execution.id, None)
            execution.context = context.state
            if execution.id not in self._lease_lost:
                await self._persist(execution)

    async def _execute_step(
        self, step: dict[str, Any], context: WorkflowContext, execution: WorkflowExecution, path: str
    ) -> None:
        """Execute a single step, checkpointing its durable path."""
        if path in execution.state.get("completed_steps", []):
            return
        step_type = step["type"]

        if step_type == "step":
            await self._execute_regular_step(step, context, execution)

        elif step_type == "parallel":
            await self._execute_parallel_steps(step, context, execution, path)

        elif step_type == "branch":
            await self._execute_branch(step, context, execution, path)

        elif step_type == "saga":
            await self._execute_saga(step, context, execution, path)

        elif step_type == "delay":
            deadline = execution.state.setdefault("delays", {}).setdefault(path, self._now() + step["duration"])
            await self._persist(execution)
            await asyncio.sleep(max(0, deadline-self._now()) / 1000)
        execution.state.setdefault("completed_steps", []).append(path)
        execution.context = context.state
        await self._persist(execution)

    async def _execute_regular_step(
        self, step: dict[str, Any], context: WorkflowContext, execution: WorkflowExecution
    ) -> None:
        """Execute a regular step."""
        step_name = step["name"]
        handler = step["handler"]

        await self._log_event(execution.id, "step.started", {"step": step_name})

        await self._observer.run("flowfn.workflow.step", {"flowfn.workflow.name": self.name, "flowfn.execution.id": execution.id, "flowfn.step.name": step_name}, lambda: handler(context))

        # Update execution context
        execution.context = context.state
        execution.updated_at = self._now()
        await self._persist(execution)

        await self._log_event(execution.id, "step.completed", {"step": step_name})

    async def _execute_parallel_steps(
        self, step: dict[str, Any], context: WorkflowContext, execution: WorkflowExecution, path: str
    ) -> None:
        """Execute parallel steps."""
        handlers = step["steps"]

        await self._log_event(execution.id, "parallel.started", {"count": len(handlers)})

        # Run all in parallel
        async def invoke(index: int, handler: Any) -> None:
            child = f"{path}/{index}"
            if child not in execution.state.get("completed_steps", []):
                await self._observer.run("flowfn.workflow.step", {"flowfn.workflow.name": self.name, "flowfn.execution.id": execution.id, "flowfn.step.name": child}, lambda: handler(context))
                execution.state.setdefault("completed_steps", []).append(child)
                execution.context = context.state
                await self._persist(execution)

        tasks = [asyncio.create_task(invoke(index, handler)) for index, handler in enumerate(handlers)]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

        await self._log_event(execution.id, "parallel.completed", {"count": len(handlers)})

    async def _execute_branch(
        self, step: dict[str, Any], context: WorkflowContext, execution: WorkflowExecution, path: str
    ) -> None:
        """Execute conditional branch."""
        condition = step["condition"]
        then_workflow = step.get("then")
        else_workflow = step.get("else")

        decisions = execution.state.setdefault("branches", {})
        if path not in decisions:
            decisions[path] = bool(condition(context))
            await self._persist(execution)
        if decisions[path]:
            if then_workflow:
                for index, then_step in enumerate(then_workflow._steps):
                    await self._execute_step(then_step, context, execution, f"{path}/then/{index}")
        else:
            if else_workflow:
                for index, else_step in enumerate(else_workflow._steps):
                    await self._execute_step(else_step, context, execution, f"{path}/else/{index}")

    async def _execute_saga(
        self, step: dict[str, Any], context: WorkflowContext, execution: WorkflowExecution, path: str
    ) -> None:
        """Execute saga step."""
        saga_name = step["name"]
        execute_handler = step["execute"]
        compensate_handler = step["compensate"]

        await self._log_event(execution.id, "saga.started", {"saga": saga_name})

        # Add to saga stack
        if path not in execution.state.setdefault("sagas", []):
            execution.state["sagas"].append(path)
            self._saga_stacks[execution.id].append({"name": saga_name, "compensate": compensate_handler, "path": path})
            await self._persist(execution)

        # Execute
        await self._observer.run("flowfn.workflow.step", {"flowfn.workflow.name": self.name, "flowfn.execution.id": execution.id, "flowfn.step.name": step["name"]}, lambda: execute_handler(context))

        await self._log_event(execution.id, "saga.completed", {"saga": saga_name})

    async def _execute_delay(self, step: dict[str, Any]) -> None:
        """Execute delay step."""
        duration = step["duration"]
        await asyncio.sleep(duration / 1000.0)

    async def _run_compensations(self, context: WorkflowContext, execution_id: str) -> None:
        """Run saga compensations in reverse order."""
        stack = self._saga_stacks.get(execution_id, [])
        while stack:
            saga = stack.pop()
            execution = self._executions[execution_id]
            execution.state["sagas"].remove(saga["path"])
            try:
                await self._observer.run("flowfn.workflow.compensate", {"flowfn.workflow.name": self.name, "flowfn.execution.id": execution_id, "flowfn.step.name": saga["name"]}, lambda: saga["compensate"](context))
                await self._log_event(execution_id, "saga.compensated", {"saga": saga["name"]})
            except Exception as error:
                await self._log_event(execution_id, "saga.compensation_failed", {"saga": saga["name"], "error": str(error)})

    async def get_execution(self, execution_id: str) -> WorkflowExecution:
        """Get execution by ID."""
        # Check local cache first
        if execution_id in self._executions:
            cached = self._executions[execution_id]
            if cached.workflow_id != self.name:
                raise ValueError(f"Execution not found: {execution_id}")
            return cached

        # Load from adapter
        execution = await self._adapter.load_workflow_state(execution_id)
        if not execution or execution.workflow_id != self.name:
            raise ValueError(f"Execution not found: {execution_id}")

        return execution

    async def list_executions(self, opts: Optional[ListOptions] = None) -> list[WorkflowExecution]:
        """List executions."""
        options = opts or ListOptions()

        executions = await self._adapter.list_workflow_states(self.name)

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
        await self.get_execution(execution_id)
        cancelled = await self._adapter.transition_workflow_state(execution_id,"cancel",{"workflow_id":self.name})
        if cancelled is None:
            raise ValueError(f"Execution not found: {execution_id}")
        if cancelled.status == ExecutionStatus.CANCELLED:
            current = self._executions.get(execution_id)
            if current is not None:
                current.status = ExecutionStatus.CANCELLED
            self._lease_lost.add(execution_id)
            task = self._tasks.get(execution_id)
            if task is not None and task is not asyncio.current_task():
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)

    async def _cancel_owned(self, execution_id: str) -> None:
        execution = self._executions[execution_id]
        try:
            await self._adapter.transition_workflow_state(execution_id,"cancel_owned",{
                "workflow_id":self.name,"token":execution.lease_token,
            })
        finally:
            # Local shutdown must stop its own task even if storage is unavailable
            # or another process has already reclaimed the persisted execution.
            self._lease_lost.add(execution_id)
            execution.status = ExecutionStatus.CANCELLED
            task = self._tasks.get(execution_id)
            if task is not None and task is not asyncio.current_task():
                task.cancel()

    async def close(self) -> None:
        """Stop local tasks and cancel only their still-owned persisted executions."""
        self._closed = True
        await self._admissions.drain()
        tasks = list(self._tasks.values())
        heartbeats = list(self._heartbeats.values())
        results = await asyncio.gather(*(self._cancel_owned(identity) for identity in list(self._tasks)),return_exceptions=True)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if heartbeats:
            await asyncio.gather(*heartbeats, return_exceptions=True)
        failures = [item for item in results if isinstance(item,BaseException)]
        if failures:
            raise RuntimeError('Workflow shutdown persistence failed') from failures[0]

    async def retry_execution(self, execution_id: str) -> WorkflowExecution:
        """Retry a failed execution."""
        old_execution = await self.get_execution(execution_id)

        if old_execution.status != ExecutionStatus.FAILED:
            raise ValueError("Can only retry failed executions")

        # Create new execution with same input
        return await self.execute(old_execution.input)

    async def get_execution_history(self, execution_id: str) -> list[WorkflowEvent]:
        """Get execution event history."""
        execution = await self.get_execution(execution_id)
        return [WorkflowEvent.model_validate(event) for event in execution.state.get("events", [])]

    async def get_metrics(self) -> dict[str, Any]:
        """Get workflow metrics."""
        executions = await self._adapter.list_workflow_states(self.name)

        total = len(executions)
        completed = len([e for e in executions if e.status == ExecutionStatus.COMPLETED])
        failed = len([e for e in executions if e.status == ExecutionStatus.FAILED])

        # Calculate average duration
        durations = [
            e.completed_at - e.started_at for e in executions if e.completed_at is not None
        ]
        avg_duration = sum(durations) / len(durations) if durations else 0

        return {
            "totalExecutions": total,
            "running": len([e for e in executions if e.status == ExecutionStatus.RUNNING]),
            "completed": completed,
            "failed": failed,
            "successRate": (completed / total * 100) if total > 0 else 0,
            "avgDuration": avg_duration,
        }

    async def _log_event(
        self, execution_id: str, event_type: str, data: Optional[dict[str, Any]] = None
    ) -> None:
        """Log workflow event."""
        event = WorkflowEvent(
            id=str(uuid.uuid4()),
            execution_id=execution_id,
            type=event_type,
            timestamp=self._now(),
            data=data,
        )

        execution = await self.get_execution(execution_id)
        execution.state.setdefault("events", []).append(event.model_dump(mode="json"))
        await self._persist(execution)
        if self._events is not None and event_type in ("execution.started", "execution.completed", "execution.failed"):
            await self._events.emit("workflow:" + event_type.split(".")[1], {
                "workflow_name": self.name, "execution_id": execution_id,
                **{key: value for key, value in (data or {}).items() if key in ("duration", "error")},
            })

    def _now(self) -> int:
        """Get current timestamp in ms."""
        return int(time.time() * 1000)
