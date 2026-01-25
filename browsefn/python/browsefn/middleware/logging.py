"""
Logging middleware for request/response tracking
"""

from typing import List, Dict, Any, Optional, Literal
from datetime import datetime
from pydantic import BaseModel


LogLevel = Literal['debug', 'info', 'warn', 'error']


class LogEntry(BaseModel):
    """Single log entry"""
    timestamp: float
    level: LogLevel
    message: str
    context: Dict[str, Any]


class Logger:
    """Logger for tracking browsefn events"""
    
    def __init__(self):
        self.logs: List[LogEntry] = []
    
    def log(
        self,
        level: LogLevel,
        message: str,
        context: Optional[Dict[str, Any]] = None
    ) -> None:
        """Add a log entry"""
        entry = LogEntry(
            timestamp=datetime.now().timestamp() * 1000,
            level=level,
            message=message,
            context=context or {}
        )
        self.logs.append(entry)
    
    def debug(self, message: str, context: Optional[Dict[str, Any]] = None) -> None:
        """Log debug message"""
        self.log('debug', message, context)
    
    def info(self, message: str, context: Optional[Dict[str, Any]] = None) -> None:
        """Log info message"""
        self.log('info', message, context)
    
    def warn(self, message: str, context: Optional[Dict[str, Any]] = None) -> None:
        """Log warning message"""
        self.log('warn', message, context)
    
    def error(self, message: str, context: Optional[Dict[str, Any]] = None) -> None:
        """Log error message"""
        self.log('error', message, context)
    
    def get_logs(
        self,
        filter_opts: Optional[Dict[str, Any]] = None
    ) -> List[LogEntry]:
        """Get logs with optional filtering"""
        if not filter_opts:
            return self.logs.copy()
        
        filtered_logs = self.logs.copy()
        
        # Filter by provider
        if 'provider' in filter_opts:
            provider = filter_opts['provider']
            filtered_logs = [
                log for log in filtered_logs
                if log.context.get('provider') == provider
            ]
        
        # Filter by timestamp (since)
        if 'since' in filter_opts:
            since = filter_opts['since']
            filtered_logs = [
                log for log in filtered_logs
                if log.timestamp >= since
            ]
        
        return filtered_logs
    
    def clear(self) -> None:
        """Clear all logs"""
        self.logs.clear()
