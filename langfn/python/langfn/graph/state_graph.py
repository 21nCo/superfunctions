from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Generic, Optional, TypeVar


TState = TypeVar("TState", bound=Dict[str, Any])
NodeFn = Callable[[TState], Awaitable[TState]]
RouteFn = Callable[[TState], str]


END = "__end__"


class StateGraph(Generic[TState]):
    def __init__(self, *, initial_state: TState):
        self._initial_state = dict(initial_state)
        self._nodes: Dict[str, NodeFn] = {}
        self._edges: Dict[str, str] = {}
        self._conditional_edges: Dict[str, RouteFn] = {}
        self._entrypoint: Optional[str] = None

    def add_node(self, name: str, fn: NodeFn) -> "StateGraph[TState]":
        if name in self._nodes:
            raise ValueError(f"Node already exists: {name}")
        self._nodes[name] = fn
        return self

    def add_edge(self, from_node: str, to_node: str) -> "StateGraph[TState]":
        self._edges[from_node] = to_node
        return self

    def add_conditional_edge(self, from_node: str, router: RouteFn) -> "StateGraph[TState]":
        self._conditional_edges[from_node] = router
        return self

    def set_entry_point(self, name: str) -> "StateGraph[TState]":
        self._entrypoint = name
        return self

    def compile(self) -> "CompiledGraph[TState]":
        if self._entrypoint is None:
            raise ValueError("Entry point not set")
        if self._entrypoint not in self._nodes:
            raise ValueError(f"Entry point node not found: {self._entrypoint}")
        return CompiledGraph(
            initial_state=self._initial_state,
            nodes=self._nodes,
            edges=self._edges,
            conditional_edges=self._conditional_edges,
            entrypoint=self._entrypoint,
        )


@dataclass(frozen=True)
class CompiledGraph(Generic[TState]):
    initial_state: TState
    nodes: Dict[str, NodeFn]
    edges: Dict[str, str]
    conditional_edges: Dict[str, RouteFn]
    entrypoint: str

    async def invoke(self, state: Optional[TState] = None, *, max_steps: int = 100) -> TState:
        current_state: TState = dict(self.initial_state)
        if state is not None:
            current_state.update(state)

        node = self.entrypoint
        steps = 0
        while True:
            steps += 1
            if steps > max_steps:
                raise RuntimeError("Graph exceeded max_steps")

            fn = self.nodes.get(node)
            if fn is None:
                raise KeyError(f"Unknown node: {node}")

            current_state = await fn(current_state)

            if node in self.conditional_edges:
                next_node = self.conditional_edges[node](current_state)
                if next_node == END:
                    return current_state
                node = next_node
                continue

            next_node = self.edges.get(node)
            if next_node is None:
                return current_state
            if next_node == END:
                return current_state
            node = next_node

    async def ainvoke(self, state: Optional[TState] = None, *, max_steps: int = 100) -> TState:
        return await self.invoke(state, max_steps=max_steps)

