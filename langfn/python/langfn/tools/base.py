from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Generic, Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

from ..core.errors import LangFnError, ToolExecutionError, ToolSchemaError
from .policy import ToolPolicy

TArgs = TypeVar("TArgs", bound=BaseModel)
TResult = TypeVar("TResult")


@dataclass(frozen=True)
class ToolContext:
    metadata: Dict[str, Any] = field(default_factory=dict)
    policy: ToolPolicy = field(default_factory=ToolPolicy)


@dataclass(frozen=True)
class Tool(Generic[TArgs, TResult]):
    name: str
    description: str
    args_schema: Type[TArgs]
    execute: Callable[[TArgs, ToolContext], Awaitable[TResult]]

    def json_schema(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.args_schema.model_json_schema(),
        }

    async def run(self, args: Dict[str, Any], *, context: Optional[ToolContext] = None) -> TResult:
        try:
            parsed = self.args_schema.model_validate(args)
        except ValidationError as exc:
            raise ToolSchemaError(
                "Tool args do not match schema",
                metadata={"tool": self.name, "errors": exc.errors()},
            ) from exc

        ctx = context or ToolContext()
        try:
            result = await self.execute(parsed, ctx)
            return ctx.policy.sanitize(result)
        except LangFnError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ToolExecutionError(
                f"Tool '{self.name}' failed: {exc}",
                metadata={"tool": self.name},
            ) from exc
