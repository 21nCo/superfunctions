from __future__ import annotations

import ast
import operator
from typing import Any

from pydantic import BaseModel, Field

from ..core.errors import ToolPolicyViolationError
from .base import Tool, ToolContext

_BINARY_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}


class CalculatorArgs(BaseModel):
    expression: str = Field(..., description="The mathematical expression to evaluate")


def calculator(expression: str) -> str:
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:  # pragma: no cover - parser already exercised via validation path
        raise ToolPolicyViolationError("Invalid calculator expression", metadata={"expression": expression}) from exc
    return str(_evaluate(tree.body))


def _evaluate(node: ast.AST) -> Any:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY_OPS:
        return _BINARY_OPS[type(node.op)](_evaluate(node.left), _evaluate(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_evaluate(node.operand))
    raise ToolPolicyViolationError("Calculator expression uses a disallowed grammar")


async def calculate(args: CalculatorArgs, _context: ToolContext) -> str:
    return calculator(args.expression)


def CalculatorTool() -> Tool[CalculatorArgs, str]:
    return Tool(
        name="calculator",
        description="Perform basic mathematical calculations.",
        args_schema=CalculatorArgs,
        execute=calculate,
    )
