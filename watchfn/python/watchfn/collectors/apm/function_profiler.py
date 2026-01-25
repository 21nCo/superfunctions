"""Function profiler for APM."""

from typing import Any, Dict, Optional, Callable
import time
import functools
import asyncio


class FunctionProfiler:
    """Profile function execution for performance monitoring."""
    
    def __init__(self, track_callback: Callable[[str, Dict[str, Any]], None], slow_threshold: int = 1000):
        self.track_callback = track_callback
        self.slow_threshold = slow_threshold
        self.enabled = True
    
    def profile(self, name: Optional[str] = None, tags: Optional[Dict[str, str]] = None):
        """Decorator to profile a function."""
        def decorator(func):
            func_name = name or f"{func.__module__}.{func.__name__}"
            
            if asyncio.iscoroutinefunction(func):
                @functools.wraps(func)
                async def async_wrapper(*args, **kwargs):
                    if not self.enabled:
                        return await func(*args, **kwargs)
                    
                    start_time = time.time()
                    error = None
                    
                    try:
                        result = await func(*args, **kwargs)
                        return result
                    except Exception as e:
                        error = e
                        raise
                    finally:
                        duration = (time.time() - start_time) * 1000
                        self._track_execution(func_name, duration, error, tags)
                
                return async_wrapper
            else:
                @functools.wraps(func)
                def wrapper(*args, **kwargs):
                    if not self.enabled:
                        return func(*args, **kwargs)
                    
                    start_time = time.time()
                    error = None
                    
                    try:
                        return func(*args, **kwargs)
                    except Exception as e:
                        error = e
                        raise
                    finally:
                        duration = (time.time() - start_time) * 1000
                        self._track_execution(func_name, duration, error, tags)
                
                return wrapper
        
        return decorator
    
    def _track_execution(self, name: str, duration: float, error: Optional[Exception], tags: Optional[Dict[str, str]]):
        """Track function execution."""
        is_slow = duration > self.slow_threshold
        
        event_data = {
            "function": name,
            "duration": duration,
            "slow": is_slow,
            "type": "function",
        }
        
        if tags:
            event_data["tags"] = tags
        
        if error:
            event_data["error"] = str(error)
            event_data["error_type"] = type(error).__name__
        
        event_name = "function.slow" if is_slow else "function.execution"
        self.track_callback(event_name, event_data)
    
    def enable(self):
        """Enable profiling."""
        self.enabled = True
    
    def disable(self):
        """Disable profiling."""
        self.enabled = False
