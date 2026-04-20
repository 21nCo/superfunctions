from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Protocol

from ..core.errors import AgentMaxIterationsError, InternalError, ValidationError


class RunnableAgent(Protocol):
    async def run(self, task: str) -> Any: ...


Coordinator = Callable[[str, dict[str, List[str]]], Awaitable[str]]


@dataclass
class MultiAgentResult:
    decisions: List[str]
    outputs: List[str]
    output: str


class MultiAgentCoordinator:
    def __init__(
        self,
        *,
        agents: Dict[str, RunnableAgent],
        coordinator: Coordinator,
        max_iterations: int = 5,
    ):
        self._agents = agents
        self._coordinator = coordinator
        self._max_iterations = max_iterations

    async def run(self, task: str) -> MultiAgentResult:
        decisions: List[str] = []
        outputs: List[str] = []
        current_task = task

        for _ in range(self._max_iterations):
            try:
                decision = await self._coordinator(
                    current_task,
                    {"decisions": list(decisions), "outputs": list(outputs)},
                )
            except Exception as exc:  # noqa: BLE001
                raise InternalError("Coordinator failed to select an agent") from exc

            if decision == "__end__":
                return MultiAgentResult(decisions=decisions, outputs=outputs, output=outputs[-1] if outputs else "")

            agent = self._agents.get(decision)
            if agent is None:
                raise ValidationError(f"Unknown agent: {decision}", metadata={"agent": decision})

            decisions.append(decision)
            result = await agent.run(current_task)
            outputs.append(result.output if hasattr(result, "output") else str(result))
            current_task = outputs[-1]

        raise AgentMaxIterationsError("Coordinator exceeded max iterations", metadata={"max_iterations": self._max_iterations})
