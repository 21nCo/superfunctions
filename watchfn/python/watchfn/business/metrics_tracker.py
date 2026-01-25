"""Business metrics tracking and analysis."""

from typing import List, Dict, Any, Optional, Literal
from dataclasses import dataclass
import time


@dataclass
class BusinessEvent:
    name: str
    timestamp: float
    properties: Dict[str, Any]
    user_id: Optional[str] = None
    value: Optional[float] = None


@dataclass
class KPI:
    name: str
    value: float
    target: Optional[float] = None
    timestamp: float = 0
    trend: Literal["up", "down", "flat"] = "flat"


class BusinessMetricsTracker:
    """Track business events and calculate KPIs."""
    
    def __init__(self, max_events: int = 1000000):
        self.events: List[BusinessEvent] = []
        self.max_events = max_events
    
    def track(self, event: Dict[str, Any]) -> BusinessEvent:
        """Track a business event."""
        business_event = BusinessEvent(
            name=event.get("name", ""),
            timestamp=time.time() * 1000,
            properties=event.get("properties", {}),
            user_id=event.get("user_id"),
            value=event.get("value")
        )
        
        self.events.append(business_event)
        
        # Keep only recent events
        if len(self.events) > self.max_events:
            self.events.pop(0)
        
        return business_event
    
    def calculate_kpi(
        self,
        name: str,
        event: str,
        aggregation: Literal["count", "sum", "avg"],
        from_time: float,
        to_time: float,
        value_field: Optional[str] = None,
        target: Optional[float] = None
    ) -> KPI:
        """Calculate a KPI."""
        events = [
            e for e in self.events
            if e.name == event and from_time <= e.timestamp <= to_time
        ]
        
        if aggregation == "count":
            value = float(len(events))
        elif aggregation == "sum":
            value = sum(e.properties.get(value_field, 0) for e in events)
        elif aggregation == "avg":
            values = [e.properties.get(value_field, 0) for e in events]
            value = sum(values) / len(values) if values else 0.0
        else:
            value = 0.0
        
        return KPI(
            name=name,
            value=value,
            target=target,
            timestamp=time.time() * 1000
        )
    
    def get_revenue(
        self,
        from_time: float,
        to_time: float,
        group_by: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Get revenue metrics."""
        revenue_events = [
            e for e in self.events
            if e.value is not None and from_time <= e.timestamp <= to_time
        ]
        
        if not group_by:
            total = sum(e.value for e in revenue_events if e.value)
            return [{"revenue": total}]
        
        groups: Dict[str, float] = {}
        for event in revenue_events:
            group = event.properties.get(group_by, "unknown")
            groups[group] = groups.get(group, 0.0) + (event.value or 0.0)
        
        return [{"group": k, "revenue": v} for k, v in groups.items()]
