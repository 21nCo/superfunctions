from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Generic, Optional, TypeVar, Union

from ..core.errors import GraphInterruptError, GraphMaxStepsError, InternalError, ValidationError
from .checkpoint import CheckpointStore, GraphCheckpoint, InMemoryCheckpointStore


TState = TypeVar("TState", bound=Dict[str, Any])
NodeFn = Callable[[TState], Awaitable[TState]]
RouteFn = Callable[[TState], Union[Awaitable[str], str]]


END = "__end__"


class StateGraph(Generic[TState]):
    def __init__(self, *, initial_state: TState):
        self._initial_state = dict(initial_state)
        self._nodes: Dict[str, NodeFn] = {}
        self._edges: Dict[str, str] = {}
        self._conditional_edges: Dict[str, RouteFn] = {}
        self._interrupt_before: set[str] = set()
        self._entrypoint: Optional[str] = None

    def add_node(self, name: str, fn: NodeFn) -> "StateGraph[TState]":
        if name in self._nodes:
            raise ValidationError(f"Node already exists: {name}", metadata={"node": name})
        self._nodes[name] = fn
        return self

    def add_edge(self, from_node: str, to_node: str) -> "StateGraph[TState]":
        self._edges[from_node] = to_node
        return self

    def add_conditional_edge(self, from_node: str, router: RouteFn) -> "StateGraph[TState]":
        self._conditional_edges[from_node] = router
        return self

    def add_interrupt(self, node: str) -> "StateGraph[TState]":
        self._interrupt_before.add(node)
        return self

    def set_entry_point(self, name: str) -> "StateGraph[TState]":
        self._entrypoint = name
        return self

    def compile(self) -> "CompiledGraph[TState]":
        if self._entrypoint is None:
            raise ValidationError("Entry point not set")
        if self._entrypoint not in self._nodes:
            raise ValidationError(
                f"Entry point node not found: {self._entrypoint}",
                metadata={"node": self._entrypoint},
            )
        return CompiledGraph(
            initial_state=self._initial_state,
            nodes=self._nodes,
            edges=self._edges,
            conditional_edges=self._conditional_edges,
            interrupt_before=self._interrupt_before,
            entrypoint=self._entrypoint,
        )


@dataclass(frozen=True)
class CompiledGraph(Generic[TState]):
    initial_state: TState
    nodes: Dict[str, NodeFn]
    edges: Dict[str, str]
    conditional_edges: Dict[str, RouteFn]
    interrupt_before: set[str]
    entrypoint: str

    async def invoke(
        self,
        state: Optional[TState] = None,
        *,
        max_steps: int = 100,
        checkpoint_store: CheckpointStore[TState] | None = None,
    ) -> TState:
        current_state: TState = dict(self.initial_state)
        if state is not None:
            current_state.update(state)
        return await self._run(
            current_state=current_state,
            node=self.entrypoint,
            steps=0,
            max_steps=max_steps,
            checkpoint_store=checkpoint_store,
        )

    async def resume(
        self,
        checkpoint_id: str,
        *,
        max_steps: int = 100,
        checkpoint_store: CheckpointStore[TState] | None = None,
    ) -> TState:
        store = checkpoint_store or InMemoryCheckpointStore[TState]()
        checkpoint = await store.load(checkpoint_id)
        if checkpoint is None:
            raise ValidationError(f"Unknown checkpoint: {checkpoint_id}", metadata={"checkpoint_id": checkpoint_id})
        return await self._run(
            current_state=checkpoint.state,
            node=checkpoint.node,
            steps=checkpoint.steps,
            max_steps=max_steps,
            checkpoint_store=store,
            skip_interrupt_for=checkpoint.node,
        )

    async def ainvoke(
        self,
        state: Optional[TState] = None,
        *,
        max_steps: int = 100,
        checkpoint_store: CheckpointStore[TState] | None = None,
    ) -> TState:
        return await self.invoke(state, max_steps=max_steps, checkpoint_store=checkpoint_store)

    async def _run(
        self,
        *,
        current_state: TState,
        node: str,
        steps: int,
        max_steps: int,
        checkpoint_store: CheckpointStore[TState] | None,
        skip_interrupt_for: str | None = None,
    ) -> TState:
        current_node = node
        executed_steps = steps

        while True:
            if executed_steps >= max_steps:
                raise GraphMaxStepsError("Graph exceeded max steps", metadata={"node": current_node, "max_steps": max_steps})

            if current_node in self.interrupt_before and skip_interrupt_for != current_node:
                checkpoint_id = f"chk_{executed_steps:04d}_{current_node}"
                checkpoint = GraphCheckpoint(id=checkpoint_id, node=current_node, state=dict(current_state), steps=executed_steps)
                if checkpoint_store is not None:
                    await checkpoint_store.save(checkpoint)
                raise GraphInterruptError(
                    "Graph interrupted before node execution",
                    metadata={"checkpoint_id": checkpoint_id, "node": current_node},
                )
            skip_interrupt_for = None

            fn = self.nodes.get(current_node)
            if fn is None:
                raise InternalError(f"Unknown graph node: {current_node}", metadata={"node": current_node})

            try:
                current_state = await fn(current_state)
            except Exception as exc:  # noqa: BLE001
                if hasattr(exc, "code"):
                    raise
                raise InternalError(f"Graph node '{current_node}' failed", metadata={"node": current_node}) from exc

            executed_steps += 1

            if current_node in self.conditional_edges:
                try:
                    next_node = self.conditional_edges[current_node](current_state)
                    if hasattr(next_node, "__await__"):
                        next_node = await next_node  # type: ignore[assignment]
                except Exception as exc:  # noqa: BLE001
                    raise InternalError(f"Conditional edge '{current_node}' failed", metadata={"node": current_node}) from exc
                if next_node == END:
                    return current_state
                if next_node not in self.nodes:
                    raise InternalError(f"Unknown graph node: {next_node}", metadata={"node": next_node})
                current_node = next_node
                continue

            next_node = self.edges.get(current_node)
            if next_node is None or next_node == END:
                return current_state
            if next_node not in self.nodes:
                raise InternalError(f"Unknown graph node: {next_node}", metadata={"node": next_node})
            current_node = next_node
