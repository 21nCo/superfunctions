"""Database query tracer for APM."""

from typing import Any, Dict, Optional, Callable
import time
from contextlib import contextmanager


class DatabaseTracer:
    """Trace database queries for performance monitoring."""
    
    def __init__(self, track_callback: Callable[[str, Dict[str, Any]], None], slow_threshold: int = 100):
        self.track_callback = track_callback
        self.slow_threshold = slow_threshold
    
    @contextmanager
    def trace_query(self, query: str, params: Optional[Dict[str, Any]] = None):
        """Context manager to trace a database query."""
        start_time = time.time()
        error = None
        
        try:
            yield
        except Exception as e:
            error = e
            raise
        finally:
            duration = (time.time() - start_time) * 1000  # Convert to ms
            self._track_query(query, duration, params, error)
    
    async def trace_query_async(self, query: str, func, params: Optional[Dict[str, Any]] = None):
        """Trace an async database query."""
        start_time = time.time()
        error = None
        
        try:
            result = await func()
            return result
        except Exception as e:
            error = e
            raise
        finally:
            duration = (time.time() - start_time) * 1000
            self._track_query(query, duration, params, error)
    
    def _track_query(self, query: str, duration: float, params: Optional[Dict[str, Any]], error: Optional[Exception]):
        """Track  a query execution."""
        is_slow = duration > self.slow_threshold
        
        event_data = {
            "query": query,
            "duration": duration,
            "params": params or {},
            "slow": is_slow,
            "type": "database",
        }
        
        if error:
            event_data["error"] = str(error)
            event_data["error_type"] = type(error).__name__
        
        event_name = "db.query.slow" if is_slow else "db.query"
        self.track_callback(event_name, event_data)
