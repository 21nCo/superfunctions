from __future__ import annotations

import math
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field
from .base import Tool, ToolContext


class CalculatorArgs(BaseModel):
    expression: str = Field(..., description="The mathematical expression to evaluate (e.g., '2 + 2 * 5')")


async def calculate(args: CalculatorArgs, context: ToolContext) -> str:
    expression = args.expression
    # Simple/Safe evaluation (very basic)
    try:
        # Only allow a subset of characters for safety
        safe_chars = "0123456789+-*/(). "
        if not all(c in safe_chars for c in expression):
             return "Error: Invalid characters in expression"
        
        # We use a limited scope for eval
        result = eval(expression, {"__builtins__": {}}, {"math": math})
        return str(result)
    except Exception as e:
        return f"Error: {str(e)}"


def CalculatorTool() -> Tool[CalculatorArgs, str]:
    return Tool(
        name="calculator",
        description="Perform basic mathematical calculations (add, subtract, multiply, divide, power).",
        args_schema=CalculatorArgs,
        execute=calculate
    )
