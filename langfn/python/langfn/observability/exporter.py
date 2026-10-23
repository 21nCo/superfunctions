from __future__ import annotations

from typing import Any, Dict, Optional, Protocol


class SpanExporter(Protocol):
    async def export(self, name: str, metadata: Optional[Dict[str, Any]] = None) -> None: ...


class OtlpExporter(Protocol):
    async def export(self, payload: Dict[str, Any]) -> None: ...


class ObservabilityExporter:
    def __init__(
        self,
        *,
        watch: Optional[Any] = None,
        exporter: Optional[SpanExporter] = None,
        otlp_exporter: Optional[OtlpExporter] = None,
    ):
        self._watch = watch
        self._exporter = exporter
        self._otlp_exporter = otlp_exporter

    async def emit(self, name: str, payload: Dict[str, Any]) -> None:
        if self._watch is not None:
            self._watch.track(name, payload)
        if self._exporter is not None:
            await self._exporter.export(name, payload)
        if self._otlp_exporter is not None:
            await self._otlp_exporter.export({"name": name, **payload})
