"""W3C Trace Context propagation."""

from typing import Dict, Optional
from dataclasses import dataclass
import random
import string


@dataclass
class TraceContext:
    """W3C Trace Context."""
    trace_id: str
    span_id: str
    parent_span_id: Optional[str] = None
    trace_flags: int = 1
    trace_state: Optional[str] = None


class TraceContextPropagator:
    """Propagate W3C Trace Context in distributed systems."""
    
    def extract(self, headers: Dict[str, str]) -> Optional[TraceContext]:
        """Extract trace context from headers."""
        traceparent = self._get_header(headers, "traceparent")
        if not traceparent:
            return None
        
        parts = traceparent.split("-")
        if len(parts) != 4:
            return None
        
        version, trace_id, span_id, trace_flags = parts
        
        context = TraceContext(
            trace_id=trace_id,
            span_id=span_id,
            trace_flags=int(trace_flags, 16)
        )
        
        tracestate = self._get_header(headers, "tracestate")
        if tracestate:
            context.trace_state = tracestate
        
        return context
    
    def inject(self, context: TraceContext, headers: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        """Inject trace context into headers."""
        if headers is None:
            headers = {}
        
        traceparent = f"00-{context.trace_id}-{context.span_id}-{self._format_flags(context.trace_flags)}"
        headers["traceparent"] = traceparent
        
        if context.trace_state:
            headers["tracestate"] = context.trace_state
        
        return headers
    
    def create(self, parent_span_id: Optional[str] = None) -> TraceContext:
        """Create a new trace context."""
        return TraceContext(
            trace_id=self._generate_trace_id(),
            span_id=self._generate_span_id(),
            parent_span_id=parent_span_id,
            trace_flags=1  # Sampled
        )
    
    def create_child(self, parent: TraceContext) -> TraceContext:
        """Create a child span context."""
        return TraceContext(
            trace_id=parent.trace_id,
            span_id=self._generate_span_id(),
            parent_span_id=parent.span_id,
            trace_flags=parent.trace_flags,
            trace_state=parent.trace_state
        )
    
    def _get_header(self, headers: Dict[str, str], name: str) -> Optional[str]:
        """Get header value (case-insensitive)."""
        for key, value in headers.items():
            if key.lower() == name.lower():
                return value
        return None
    
    def _format_flags(self, flags: int) -> str:
        """Format flags as 2-digit hex."""
        return format(flags, '02x')
    
    def _generate_trace_id(self) -> str:
        """Generate 32 hex character trace ID."""
        return ''.join(random.choices(string.hexdigits.lower(), k=32))
    
    def _generate_span_id(self) -> str:
        """Generate 16 hex character span ID."""
        return ''.join(random.choices(string.hexdigits.lower(), k=16))


# Singleton instance
trace_context_propagator = TraceContextPropagator()
