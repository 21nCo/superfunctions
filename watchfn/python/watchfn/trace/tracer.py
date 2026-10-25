"""Tracer for distributed tracing."""

from typing import Optional, Dict, Any
from dataclasses import dataclass, field
from threading import RLock
from secrets import token_hex
from copy import deepcopy
from .queries import TraceQueries
import time
from contextlib import contextmanager


@dataclass
class Span:
    trace_id: str
    span_id: str
    parent_span_id: Optional[str]
    operation: str
    start_time: float
    end_time: Optional[float] = None
    duration: Optional[float] = None
    tags: Optional[Dict[str, str]] = None
    logs: Optional[list] = None
    status: str = "ok"
    
    _on_finish: Any = field(default=None, repr=False, compare=False)
    _recorded: bool = field(default=False, repr=False, compare=False)
    _lock: Any = field(default_factory=RLock, repr=False, compare=False)

    def finish(self):
        """Finish once; a failed recording can be retried without changing timing."""
        with self._lock:
            if self.end_time is None:
                self.end_time = time.time() * 1000
                self.duration = self.end_time - self.start_time
            if self._on_finish is not None and not self._recorded:
                self._on_finish(self)
                self._recorded = True
    
    def set_tag(self, key: str, value: str):
        """Set a tag on the span."""
        if self.tags is None:
            self.tags = {}
        self.tags[key] = value
    
    def log(self, message: str, data: Optional[Dict[str, Any]] = None):
        """Add a log to the span."""
        if self.logs is None:
            self.logs = []
        self.logs.append({
            "timestamp": time.time() * 1000,
            "message": message,
            "data": data
        })
    
    def set_error(self, error: Exception):
        """Mark span as error."""
        self.status = "error"
        self.set_tag("error", "true")
        self.set_tag("error.type", type(error).__name__)
        self.log(f"Error: {str(error)}")


class Tracer(TraceQueries):
    """Tracer for distributed tracing."""
    
    def __init__(self, service_name: str, track_callback, query=None):
        super().__init__(query or self._unavailable_query)
        self.service_name = service_name
        self.track_callback = track_callback
        self.active_spans: Dict[str, Span] = {}
    
    @staticmethod
    def _unavailable_query(_options):
        raise RuntimeError("Trace query storage is unavailable")

    def start_span(
        self,
        operation: str,
        trace_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None
    ) -> Span:
        """Start a new span."""
        if trace_id is None:
            trace_id = token_hex(16)
        span_id = token_hex(8)

        span = Span(
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            operation=operation,
            start_time=time.time() * 1000,
            tags=deepcopy(tags or {}),
            _on_finish=self._record_span
        )
        
        span.set_tag("service.name", self.service_name)
        self.active_spans[span_id] = span
        
        return span
    
    def finish_span(self, span: Span):
        """Finish and record a span at most once."""
        span.finish()

    def _record_span(self, span: Span):
        tags = deepcopy(span.tags or {})
        if span.status == "error":
            tags["error"] = True
        self.track_callback("trace.span", {
            "id": span.span_id, "traceId": span.trace_id, "name": span.operation,
            "startTime": span.start_time, "endTime": span.end_time,
            "service": self.service_name,
            **({"parentId": span.parent_span_id} if span.parent_span_id is not None else {}),
            "trace_id": span.trace_id, "span_id": span.span_id,
            "parent_span_id": span.parent_span_id, "operation": span.operation,
            "duration": span.duration, "tags": tags,
            "logs": deepcopy(span.logs or []), "status": span.status,
        })
        self.active_spans.pop(span.span_id, None)

    @contextmanager
    def trace(
        self,
        operation: str,
        trace_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None
    ):
        """Context manager for tracing."""
        span = self.start_span(operation, trace_id, parent_span_id, tags)
        
        try:
            yield span
        except Exception as e:
            span.set_error(e)
            raise
        finally:
            self.finish_span(span)
