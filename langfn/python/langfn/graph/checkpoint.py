from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Generic, Optional, TypeVar


TState = TypeVar("TState")


@dataclass(frozen=True)
class GraphCheckpoint(Generic[TState]):
    id: str
    node: str
    state: TState
    steps: int


class CheckpointStore(Generic[TState]):
    async def save(self, checkpoint: GraphCheckpoint[TState]) -> None:
        raise NotImplementedError

    async def load(self, checkpoint_id: str) -> Optional[GraphCheckpoint[TState]]:
        raise NotImplementedError


class InMemoryCheckpointStore(CheckpointStore[TState]):
    def __init__(self):
        self._checkpoints: Dict[str, GraphCheckpoint[TState]] = {}

    async def save(self, checkpoint: GraphCheckpoint[TState]) -> None:
        self._checkpoints[checkpoint.id] = checkpoint

    async def load(self, checkpoint_id: str) -> Optional[GraphCheckpoint[TState]]:
        return self._checkpoints.get(checkpoint_id)
