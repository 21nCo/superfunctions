"""Exception handler for error tracking."""

from typing import Any, Dict, Optional, List, Callable
import traceback
import sys


class ExceptionHandler:
    """Capture and track exceptions."""
    
    def __init__(self, track_callback: Callable[[str, Dict[str, Any]], None]):
        self.track_callback = track_callback
        self.enabled = True
        self.ignore_errors: List[str] = []
    
    def capture_exception(
        self,
        error: Exception,
        context: Optional[Dict[str, Any]] = None,
        level: str = "error",
        tags: Optional[List[str]] = None
    ) -> None:
        """Capture an exception."""
        if not self.enabled:
            return
        
        error_type = type(error).__name__
        
        # Check if error should be ignored
        if error_type in self.ignore_errors:
            return
        
        event_data = {
            "type": "error",
            "error_type": error_type,
            "error_message": str(error),
            "stack_trace": self._format_stack_trace(error),
            "level": level,
        }
        
        if context:
            event_data["context"] = context
        
        if tags:
            event_data["tags"] = tags
        
        self.track_callback("error.exception", event_data)
    
    def capture_message(
        self,
        message: str,
        context: Optional[Dict[str, Any]] = None,
        level: str = "warning"
    ) -> None:
        """Capture a message."""
        if not self.enabled:
            return
        
        event_data = {
            "type": "message",
            "message": message,
            "level": level,
        }
        
        if context:
            event_data["context"] = context
        
        self.track_callback("error.message", event_data)
    
    def install_handlers(self) -> None:
        """Install global exception handlers."""
        sys.excepthook = self._excepthook
    
    def _excepthook(self, exc_type, exc_value, exc_traceback):
        """Global exception hook."""
        self.capture_exception(
            exc_value,
            context={"unhandled": True}
        )
        
        # Call default excepthook
        sys.__excepthook__(exc_type, exc_value, exc_traceback)
    
    def _format_stack_trace(self, error: Exception) -> List[Dict[str, Any]]:
        """Format stack trace as list of frames."""
        frames = []
        tb = error.__traceback__
        
        while tb is not None:
            frame = tb.tb_frame
            frames.append({
                "filename": frame.f_code.co_filename,
                "function": frame.f_code.co_name,
                "lineno": tb.tb_lineno,
                "locals": {k: str(v) for k, v in list(frame.f_locals.items())[:10]},  # Limit locals
            })
            tb = tb.tb_next
        
        return frames
    
    def add_ignore_error(self, error_type: str) -> None:
        """Add error type to ignore list."""
        if error_type not in self.ignore_errors:
            self.ignore_errors.append(error_type)
    
    def enable(self) -> None:
        """Enable exception capture."""
        self.enabled = True
    
    def disable(self) -> None:
        """Disable exception capture."""
        self.enabled = False
