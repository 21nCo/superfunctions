"""Breadcrumbs for error context."""

from typing import List, Dict, Any, Optional
from dataclasses import dataclass
import time


@dataclass
class Breadcrumb:
    category: str
    message: str
    level: str
    timestamp: float
    data: Optional[Dict[str, Any]] = None


class BreadcrumbsCollector:
    """Collect breadcrumbs for error context."""
    
    def __init__(self, max_breadcrumbs: int = 100):
        self.breadcrumbs: List[Breadcrumb] = []
        self.max_breadcrumbs = max_breadcrumbs
    
    def add(
        self,
        category: str,
        message: str,
        level: str = "info",
        data: Optional[Dict[str, Any]] = None
    ) -> None:
        """Add a breadcrumb."""
        breadcrumb = Breadcrumb(
            category=category,
            message=message,
            level=level,
            timestamp=time.time() * 1000,
            data=data
        )
        
        self.breadcrumbs.append(breadcrumb)
        
        # Keep only recent breadcrumbs
        if len(self.breadcrumbs) > self.max_breadcrumbs:
            self.breadcrumbs.pop(0)
    
    def get_all(self) -> List[Breadcrumb]:
        """Get all breadcrumbs."""
        return self.breadcrumbs.copy()
    
    def get_recent(self, count: int = 10) -> List[Breadcrumb]:
        """Get recent breadcrumbs."""
        return self.breadcrumbs[-count:]
    
    def clear(self) -> None:
        """Clear all breadcrumbs."""
        self.breadcrumbs.clear()
    
    def add_navigation(self, url: str, from_url: Optional[str] = None) -> None:
        """Add navigation breadcrumb."""
        self.add(
            category="navigation",
            message=f"Navigated to {url}",
            level="info",
            data={"url": url, "from": from_url}
        )
    
    def add_http_request(self, method: str, url: str, status_code: Optional[int] = None) -> None:
        """Add HTTP request breadcrumb."""
        self.add(
            category="http",
            message=f"{method} {url}",
            level="info" if not status_code or status_code < 400 else "error",
            data={"method": method, "url": url, "status_code": status_code}
        )
    
    def add_user_action(self, action: str, target: Optional[str] = None) -> None:
        """Add user action breadcrumb."""
        self.add(
            category="user",
            message=action,
            level="info",
            data={"action": action, "target": target}
        )
    
    def add_console(self, message: str, level: str = "log") -> None:
        """Add console breadcrumb."""
        self.add(
            category="console",
            message=message,
            level=level
        )
