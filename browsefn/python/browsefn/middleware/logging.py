"""Logging middleware for request/response tracking."""

from typing import List, Dict, Any, Optional, Literal
from datetime import datetime
import re
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from pydantic import BaseModel


LogLevel = Literal['debug', 'info', 'warn', 'error']


class LogEntry(BaseModel):
    """Single log entry"""
    timestamp: float
    level: LogLevel
    message: str
    context: Dict[str, Any]


class Logger:
    """Logger for tracking browsefn events."""

    SENSITIVE_KEYS = {
        "api_key",
        "apikey",
        "authorization",
        "cookie",
        "cookies",
        "client_id",
        "token",
        "signature",
        "access_token", "password", "secret", "key",
    }

    def __init__(self):
        self.logs: List[LogEntry] = []
        self.secrets: Dict[str, int] = {}

    def register_secrets(self, value: Any):
        found: set[str] = set()
        seen: set[int] = set()
        def visit(item):
            if not isinstance(item, (dict, list)) or id(item) in seen:
                return
            seen.add(id(item))
            if isinstance(item, list):
                for child in item: visit(child)
                return
            for key, child in item.items():
                if key.lower() in self.SENSITIVE_KEYS and isinstance(child, str) and child:
                    found.add(child)
                if key == "cookies" and isinstance(child, list):
                    found.update(cookie["value"] for cookie in child if isinstance(cookie, dict) and cookie.get("value"))
                visit(child)
        visit(value)
        for secret in found:
            self.secrets[secret] = self.secrets.get(secret, 0) + 1
        def release():
            for secret in found:
                self.secrets[secret] -= 1
                if not self.secrets[secret]: del self.secrets[secret]
        return release

    @classmethod
    def has_url_credentials(cls, value: str) -> bool:
        parsed = urlparse(value)
        return bool(parsed.username or parsed.password) or any(key.lower() in cls.SENSITIVE_KEYS for key, _ in parse_qsl(parsed.query))

    def _sanitize_url(self, value: str) -> str:
        parsed = urlparse(value)
        query = []
        for key, item in parse_qsl(parsed.query, keep_blank_values=True):
            if key.lower() in self.SENSITIVE_KEYS:
                query.append((key, "[REDACTED]"))
            else:
                query.append((key, item))
        netloc = parsed.netloc.rsplit("@", 1)[-1] if parsed.username or parsed.password else parsed.netloc
        return urlunparse(parsed._replace(netloc=netloc, query=urlencode(query)))

    def _sanitize(self, value: Any) -> Any:
        if isinstance(value, dict):
            sanitized: Dict[str, Any] = {}
            for key, item in value.items():
                if key.lower() in self.SENSITIVE_KEYS:
                    sanitized[key] = "[REDACTED]"
                    continue
                if key.lower() == "url" and isinstance(item, str):
                    sanitized[key] = self._sanitize_url(item)
                    continue
                sanitized[key] = self._sanitize(item)
            return sanitized

        if isinstance(value, list):
            return [self._sanitize(item) for item in value]

        if isinstance(value, str):
            if value.startswith(("http://", "https://")):
                value = self._sanitize_url(value)
            value = re.sub(r"https?://[^\s\"'<>]+", lambda match: self._sanitize_url(match.group(0)), value)
            for secret in self.secrets:
                value = value.replace(secret, "[REDACTED]")
            return value

        return value

    def log(
        self,
        level: LogLevel,
        message: str,
        context: Optional[Dict[str, Any]] = None
    ) -> None:
        """Add a sanitized log entry."""
        entry = LogEntry(
            timestamp=datetime.now().timestamp() * 1000,
            level=level,
            message=message,
            context=self._sanitize(context or {})
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
