"""Tracer for distributed tracing."""

from typing import Optional, Dict, Any
from dataclasses import dataclass
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
    
    def finish(self):
        """Finish the span."""
        self.end_time = time.time() * 1000
        self.duration = self.end_time - self.start_time
    
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


class Tracer:
    """Tracer for distributed tracing."""
    
    def __init__(self, service_name: str, track_callback):
        self.service_name = service_name
        self.track_callback = track_callback
        self.active_spans: Dict[str, Span] = {}
    
    def start_span(
        self,
        operation: str,
        trace_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
        tags: Optional[Dict[str, str]] = None
    ) -> Span:
        """Start a new span."""
        import random
        import string
        
        if trace_id is None:
            trace_id = ''.join(random.choices(string.hexdigits.lower(), k=32))
        
        span_id = ''.join(random.choices(string.hexdigits.lower(), k=16))
        
        span = Span(
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            operation=operation,
            start_time=time.time() * 1000,
            tags=tags or {}
        )
        
        span.set_tag("service.name", self.service_name)
        self.active_spans[span_id] = span
        
        return span
    
    def finish_span(self, span: Span):
        """Finish a span."""
        span.finish()
        
        if span.span_id in self.active_spans:
            del self.active_spans[span.span_id]
        
        # Track the span
        self.track_callback("trace.span", {
            "trace_id": span.trace_id,
            "span_id": span.span_id,
            "parent_span_id": span.parent_span_id,
            "operation": span.operation,
            "duration": span.duration,
            "tags": span.tags,
            "logs": span.logs,
            "status": span.status,
        })
    
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
