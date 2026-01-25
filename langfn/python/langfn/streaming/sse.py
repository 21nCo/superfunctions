from __future__ import annotations

import json
from typing import AsyncIterator

from ..client import LangFn


async def to_sse(lang: LangFn, prompt: str) -> AsyncIterator[str]:
    async for event in lang.stream(prompt):
        # Using model_dump() assuming events are Pydantic models (StreamEvent)
        data = json.dumps(event.model_dump())
        yield f"data: {data}\n\n"
