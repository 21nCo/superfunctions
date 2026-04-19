from __future__ import annotations

from contextlib import asynccontextmanager
from time import time
from typing import Any, AsyncIterator, Dict, Optional
from uuid import uuid4

try:
    from watchfn import WatchFn  # type: ignore
except Exception:  # pragma: no cover
    WatchFn = object  # type: ignore

from .exporter import ObservabilityExporter, OtlpExporter, SpanExporter
from .redaction import redact


class Tracer:
    def __init__(
        self,
        *,
        watch: Optional["WatchFn"] = None,
        storage: Optional[Any] = None,
        exporter: Optional[SpanExporter] = None,
        otlp_exporter: Optional[OtlpExporter] = None,
        redaction_keys: Optional[list[str]] = None,
    ):
        self._storage = storage
        self._exporter = ObservabilityExporter(
            watch=watch,
            exporter=exporter,
            otlp_exporter=otlp_exporter,
        )
        self._redaction_keys = redaction_keys or []

    def create_trace_id(self) -> str:
        return str(uuid4())

    def sanitize(self, payload: Any) -> Any:
        return redact(payload, keys=self._redaction_keys)

    async def emit(self, name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        safe = self.sanitize(payload)
        await self._exporter.emit(name, safe)
        return safe

    @asynccontextmanager
    async def span(
        self,
        name: str,
        metadata: Optional[Dict[str, Any]] = None,
        *,
        trace_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
    ) -> AsyncIterator[Dict[str, str]]:
        trace_id = trace_id or self.create_trace_id()
        span_id = str(uuid4())
        safe_metadata = self.sanitize(metadata or {})
        started_at = int(time() * 1000)
        succeeded = False
        await self.emit(
            name,
            {
                "phase": "start",
                "trace_id": trace_id,
                "span_id": span_id,
                "parent_span_id": parent_span_id,
                "metadata": safe_metadata,
            },
        )
        try:
            yield {"trace_id": trace_id, "span_id": span_id}
            succeeded = True
        except Exception as exc:
            if self._storage is not None:
                await self._storage.save_span(
                    {
                        "trace_id": trace_id,
                        "span_id": span_id,
                        "parent_span_id": parent_span_id,
                        "name": name,
                        "metadata": safe_metadata,
                        "status": "error",
                        "started_at": started_at,
                        "ended_at": int(time() * 1000),
                        "error": {"message": str(exc), "name": exc.__class__.__name__},
                    }
                )
            await self.emit(
                name,
                {
                    "phase": "error",
                    "trace_id": trace_id,
                    "span_id": span_id,
                    "parent_span_id": parent_span_id,
                    "metadata": safe_metadata,
                    "error": {"message": str(exc), "name": exc.__class__.__name__},
                },
            )
            raise
        finally:
            if succeeded:
                if self._storage is not None:
                    await self._storage.save_span(
                        {
                            "trace_id": trace_id,
                            "span_id": span_id,
                            "parent_span_id": parent_span_id,
                            "name": name,
                            "metadata": safe_metadata,
                            "status": "ok",
                            "started_at": started_at,
                            "ended_at": int(time() * 1000),
                        }
                    )
                await self.emit(
                    name,
                    {
                        "phase": "end",
                        "trace_id": trace_id,
                        "span_id": span_id,
                        "parent_span_id": parent_span_id,
                        "metadata": safe_metadata,
                    },
                )
