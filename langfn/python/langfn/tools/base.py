from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Generic, Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

from ..core.errors import SchemaValidationError, ToolExecutionError

TArgs = TypeVar("TArgs", bound=BaseModel)
TResult = TypeVar("TResult")


@dataclass(frozen=True)
class ToolContext:
    metadata: Dict[str, Any]


@dataclass(frozen=True)
class Tool(Generic[TArgs, TResult]):
    name: str
    description: str
    args_schema: Type[TArgs]
    execute: Callable[[TArgs, ToolContext], Awaitable[TResult]]

    def json_schema(self) -> Dict[str, Any]:
        return self.args_schema.model_json_schema()

    async def run(self, args: Dict[str, Any], *, context: Optional[ToolContext] = None) -> TResult:
        try:
            parsed = self.args_schema.model_validate(args)
        except ValidationError as exc:
            raise SchemaValidationError(
                "Tool args do not match schema",
                metadata={"tool": self.name, "errors": exc.errors()},
            ) from exc

        try:
            return await self.execute(parsed, context or ToolContext(metadata={}))
        except Exception as exc:  # noqa: BLE001
            raise ToolExecutionError(
                f"Tool '{self.name}' failed: {exc}",
                metadata={"tool": self.name},
            ) from exc

