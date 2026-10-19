"""Workflow builder implementation."""

from typing import Any, Optional, Callable, Awaitable, TYPE_CHECKING
from flowfn.workflow.types import StepHandler, ConditionFunc

if TYPE_CHECKING:
    from flowfn.workflow.workflow import Workflow


class WorkflowBuilder:
    """Fluent builder for workflows."""

    def __init__(self, name: str, adapter: Any, on_build: Optional[Callable[[Any], None]] = None):
        self._on_build = on_build
        self.name = name
        self._adapter = adapter
        self._steps: list[dict[str, Any]] = []
        self._version = "1"
        self._lease_ms = 30000

    def version(self, version: str) -> "WorkflowBuilder":
        if not version:
            raise ValueError("Workflow version must be nonempty")
        self._version = version
        return self

    def lease(self, milliseconds: int) -> "WorkflowBuilder":
        if milliseconds < 100:
            raise ValueError("Workflow lease must be at least 100 milliseconds")
        self._lease_ms = milliseconds
        return self

    def step(self, name: str, handler: StepHandler) -> "WorkflowBuilder":
        """Add a sequential step."""
        self._steps.append({"type": "step", "name": name, "handler": handler})
        return self

    def parallel(self, steps: list[StepHandler]) -> "WorkflowBuilder":
        """Add parallel steps."""
        self._steps.append({"type": "parallel", "steps": steps})
        return self

    def branch(
        self,
        condition: ConditionFunc,
        then_workflow: Optional["WorkflowBuilder"] = None,
        else_workflow: Optional["WorkflowBuilder"] = None,
    ) -> "WorkflowBuilder":
        """Add conditional branching."""
        self._steps.append(
            {"type": "branch", "condition": condition, "then": then_workflow, "else": else_workflow}
        )
        return self

    def saga(self, name: str, execute: StepHandler, compensate: StepHandler) -> "WorkflowBuilder":
        """Add saga step with compensation."""
        self._steps.append(
            {"type": "saga", "name": name, "execute": execute, "compensate": compensate}
        )
        return self

    def delay(self, duration_ms: int) -> "WorkflowBuilder":
        """Add delay step."""
        self._steps.append({"type": "delay", "duration": duration_ms})
        return self

    def build(self) -> "Workflow":
        """Build the workflow."""
        from flowfn.workflow.workflow import Workflow

        workflow = Workflow(self.name, self._adapter, self._steps, version=self._version, lease_ms=self._lease_ms)
        if self._on_build is not None:
            self._on_build(workflow)
        return workflow
