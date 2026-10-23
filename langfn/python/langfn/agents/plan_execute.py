from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, List, Optional

from ..client import LangFn
from ..core.errors import AgentMaxIterationsError, InternalError, ValidationError

Planner = Callable[[str], Awaitable[List[str]]]
Executor = Callable[[str, dict[str, Any]], Awaitable[str]]


@dataclass
class PlanExecuteResult:
    plan: List[str]
    step_results: List[str]
    output: str


class PlanExecuteAgent:
    def __init__(
        self,
        *,
        lang: Optional[LangFn] = None,
        planner: Optional[Planner] = None,
        executor: Optional[Executor] = None,
        max_plan_steps: int = 10,
        max_execution_steps: Optional[int] = None,
    ):
        self._lang = lang
        self._planner = planner
        self._executor = executor
        self._max_plan_steps = max_plan_steps
        self._max_execution_steps = max_execution_steps

    async def run(self, goal: str) -> PlanExecuteResult:
        plan = await self._create_plan(goal)
        if not plan:
            raise ValidationError("Planner returned an empty plan")
        if len(plan) > self._max_plan_steps:
            raise AgentMaxIterationsError(
                "Plan exceeds configured limit",
                metadata={"max_plan_steps": self._max_plan_steps, "plan_length": len(plan)},
            )

        step_results: List[str] = []
        execution_limit = len(plan) if self._max_execution_steps is None else self._max_execution_steps
        for step_index, step in enumerate(plan):
            if step_index >= execution_limit:
                raise AgentMaxIterationsError(
                    "Execution exceeded configured limit",
                    metadata={"max_execution_steps": execution_limit},
                )
            step_results.append(
                await self._execute_step(
                    step,
                    {
                        "goal": goal,
                        "step_index": step_index,
                        "previous_results": list(step_results),
                    },
                )
            )

        return PlanExecuteResult(plan=plan, step_results=step_results, output="\n".join(step_results))

    async def _create_plan(self, goal: str) -> List[str]:
        if self._planner is not None:
            return [step.strip() for step in await self._planner(goal) if step.strip()]
        if self._lang is None:
            raise ValidationError("PlanExecuteAgent requires a planner or LangFn instance")
        response = await self._lang.complete(f"Create a concise ordered plan for: {goal}")
        return [
            line.strip().lstrip("0123456789.-) ").strip()
            for line in response.content.splitlines()
            if line.strip()
        ]

    async def _execute_step(self, step: str, context: dict[str, Any]) -> str:
        try:
            if self._executor is not None:
                return await self._executor(step, context)
            if self._lang is None:
                raise ValidationError("PlanExecuteAgent requires an executor or LangFn instance")
            response = await self._lang.complete(f"Goal: {context['goal']}\nStep {context['step_index'] + 1}: {step}")
            return response.content
        except Exception as exc:  # noqa: BLE001
            if hasattr(exc, "code"):
                raise
            raise InternalError(
                f"Failed to execute plan step: {step}",
                metadata={"step": step, "step_index": context["step_index"]},
            ) from exc
