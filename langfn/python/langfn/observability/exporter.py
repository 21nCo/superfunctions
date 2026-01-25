from __future__ import annotations

from typing import Any, Dict, Protocol, Optional


class SpanExporter(Protocol):
    async def export(self, name: str, metadata: Optional[Dict[str, Any]] = None) -> None: ...

