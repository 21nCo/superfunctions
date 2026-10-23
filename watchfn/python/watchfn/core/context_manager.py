"""Context management for request/user tracking."""

from contextvars import ContextVar
from typing import Any, Dict, Optional
from dataclasses import dataclass, field
import time


@dataclass
class Context:
    """Request/user context."""
    request_id: Optional[str] = None
    trace_id: Optional[str] = None
    span_id: Optional[str] = None
    user_id: Optional[str] = None
    session_id: Optional[str] = None
    tags: Dict[str, str] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ContextStore:
    """Context with start time."""
    context: Context
    start_time: float


# Context variable for async context storage
_context_var: ContextVar[Optional[ContextStore]] = ContextVar("watchfn_context", default=None)


class ContextManager:
    """Manage request and user context using contextvars."""
    
    def __init__(self):
        self.global_context = Context()
    
    def run(self, context: Context, func, *args, **kwargs):
        """Run a function with a new context."""
        store = ContextStore(
            context=Context(**{**vars(self.global_context), **vars(context)}),
            start_time=time.time()
        )
        
        token = _context_var.set(store)
        try:
            return func(*args, **kwargs)
        finally:
            _context_var.reset(token)
    
    async def run_async(self, context: Context, func, *args, **kwargs):
        """Run an async function with a new context."""
        store = ContextStore(
            context=Context(**{**vars(self.global_context), **vars(context)}),
            start_time=time.time()
        )
        
        token = _context_var.set(store)
        try:
            return await func(*args, **kwargs)
        finally:
            _context_var.reset(token)
    
    def get(self) -> Optional[Context]:
        """Get the current context."""
        store = _context_var.get()
        return store.context if store else None
    
    def get_store(self) -> Optional[ContextStore]:
        """Get the current context store."""
        return _context_var.get()
    
    def set(self, updates: Dict[str, Any]) -> None:
        """Update the current context."""
        store = _context_var.get()
        if store:
            for key, value in updates.items():
                setattr(store.context, key, value)
    
    def set_tag(self, key: str, value: str) -> None:
        """Set a tag in the current context."""
        store = _context_var.get()
        if store:
            store.context.tags[key] = value
    
    def set_tags(self, tags: Dict[str, str]) -> None:
        """Set multiple tags in the current context."""
        store = _context_var.get()
        if store:
            store.context.tags.update(tags)
    
    def set_metadata(self, key: str, value: Any) -> None:
        """Set metadata in the current context."""
        store = _context_var.get()
        if store:
            store.context.metadata[key] = value
    
    def get_tag(self, key: str) -> Optional[str]:
        """Get a tag from the current context."""
        store = _context_var.get()
        return store.context.tags.get(key) if store else None
    
    def get_metadata(self, key: str) -> Any:
        """Get metadata from the current context."""
        store = _context_var.get()
        return store.context.metadata.get(key) if store else None
    
    def get_request_id(self) -> Optional[str]:
        """Get the request ID from the current context."""
        store = _context_var.get()
        return store.context.request_id if store else None
    
    def get_trace_id(self) -> Optional[str]:
        """Get the trace ID from the current context."""
        store = _context_var.get()
        return store.context.trace_id if store else None
    
    def get_user_id(self) -> Optional[str]:
        """Get the user ID from the current context."""
        store = _context_var.get()
        return store.context.user_id if store else None
    
    def get_elapsed_time(self) -> Optional[float]:
        """Get elapsed time since context started (in seconds)."""
        store = _context_var.get()
        return time.time() - store.start_time if store else None
    
    def set_global_context(self, context: Context) -> None:
        """Set global context that persists across all contexts."""
        for key, value in vars(context).items():
            if value is not None:
                setattr(self.global_context, key, value)
    
    def clear_global_context(self) -> None:
        """Clear global context."""
        self.global_context = Context()
    
    @staticmethod
    def generate_request_id() -> str:
        """Generate a unique request ID."""
        import random
        import string
        suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=9))
        return f"req_{int(time.time() * 1000)}_{suffix}"
    
    @staticmethod
    def generate_trace_id() -> str:
        """Generate a unique trace ID."""
        import random
        import string
        suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=9))
        return f"trace_{int(time.time() * 1000)}_{suffix}"
    
    @staticmethod
    def generate_span_id() -> str:
        """Generate a unique span ID."""
        import random
        import string
        suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=9))
        return f"span_{suffix}"


# Singleton instance
context_manager = ContextManager()
