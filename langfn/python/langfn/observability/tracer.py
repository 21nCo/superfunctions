from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Dict, Optional

try:
    from watchfn import WatchFn  # type: ignore
except Exception:  # pragma: no cover
    WatchFn = object  # type: ignore

from .exporter import SpanExporter
from .redaction import redact


class Tracer:
    def __init__(
        self,
        *,
        watch: Optional["WatchFn"] = None,
        exporter: Optional[SpanExporter] = None,
        redaction_keys: Optional[list[str]] = None,
    ):
        self._watch = watch
        self._exporter = exporter
        self._redaction_keys = redaction_keys or []

    @asynccontextmanager
    async def span(self, name: str, metadata: Optional[Dict[str, Any]] = None) -> AsyncIterator[None]:
        safe = redact(metadata or {}, keys=self._redaction_keys) if metadata else None
        if self._watch is not None:
            self._watch.track(name, {"phase": "start", **(safe or {})})
        if self._exporter is not None:
            await self._exporter.export(name, {"phase": "start", **(safe or {})})
        try:
            yield
        finally:
            if self._watch is not None:
                self._watch.track(name, {"phase": "end", **(safe or {})})
            if self._exporter is not None:
                await self._exporter.export(name, {"phase": "end", **(safe or {})})
