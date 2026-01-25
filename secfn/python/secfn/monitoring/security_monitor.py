"""Security monitoring and event logging."""

import time
from collections import Counter
from typing import Dict, List, Optional

from ..storage.file_storage import FileStorage
from ..types import EventQuery, SecurityEvent, SecurityEventType, SecurityMetrics, Severity
from ..utils.helpers import generate_id


class MonitoringConfig:
    """Configuration for security monitoring."""

    def __init__(
        self,
        storage: FileStorage,
        retention: Optional[int] = None,
        anomaly_detection_enabled: bool = False,
        anomaly_sensitivity: float = 0.8,
    ):
        """Initialize monitoring config.
        
        Args:
            storage: Storage backend
            retention: Event retention period in milliseconds
            anomaly_detection_enabled: Enable anomaly detection
            anomaly_sensitivity: Anomaly detection sensitivity (0-1)
        """
        self.storage = storage
        self.retention = retention or 90 * 24 * 60 * 60 * 1000  # 90 days
        self.anomaly_detection_enabled = anomaly_detection_enabled
        self.anomaly_sensitivity = anomaly_sensitivity


class SecurityMonitor:
    """Security event logging and monitoring."""

    def __init__(self, config: MonitoringConfig):
        """Initialize security monitor.
        
        Args:
            config: Monitoring configuration
        """
        self.storage = config.storage
        self.retention = config.retention
        self.anomaly_detection_enabled = config.anomaly_detection_enabled
        self.anomaly_sensitivity = config.anomaly_sensitivity

    async def log_event(
        self,
        type: SecurityEventType,
        severity: Severity,
        ip: str,
        user_id: Optional[str] = None,
        user_agent: Optional[str] = None,
        resource: Optional[str] = None,
        action: Optional[str] = None,
        metadata: Optional[Dict] = None,
    ) -> str:
        """Log a security event.
        
        Args:
            type: Event type
            severity: Event severity
            ip: IP address
            user_id: User ID
            user_agent: User agent string
            resource: Resource accessed
            action: Action performed
            metadata: Additional metadata
            
        Returns:
            Event ID
        """
        event = SecurityEvent(
            id=generate_id("event"),
            timestamp=int(time.time() * 1000),
            type=type,
            severity=severity,
            userId=user_id,
            ip=ip,
            userAgent=user_agent,
            resource=resource,
            action=action,
            metadata=metadata or {},
            resolved=False,
        )

        await self.storage.save_event(event)
        return event.id

    async def query_events(self, query: Optional[EventQuery] = None) -> List[SecurityEvent]:
        """Query security events.
        
        Args:
            query: Query parameters
            
        Returns:
            List of matching events
        """
        # Build simple query dict
        query_dict = {}
        if query:
            if query.type:
                if isinstance(query.type, list):
                    # For simplicity, just use first type
                    query_dict["type"] = query.type[0].value
                else:
                    query_dict["type"] = query.type.value

            if query.user_id:
                query_dict["userId"] = query.user_id

            if query.ip:
                query_dict["ip"] = query.ip

            if query.resolved is not None:
                query_dict["resolved"] = query.resolved

        events = await self.storage.query_events(query_dict)

        # Apply additional filters (date range, severity)
        if query:
            if query.start_date or query.end_date:
                events = [
                    e
                    for e in events
                    if (not query.start_date or e.timestamp >= query.start_date)
                    and (not query.end_date or e.timestamp <= query.end_date)
                ]

            if query.severity:
                if isinstance(query.severity, list):
                    severities = [s.value for s in query.severity]
                    events = [e for e in events if e.severity.value in severities]
                else:
                    events = [e for e in events if e.severity == query.severity]

            # Apply limit and offset
            if query.offset:
                events = events[query.offset :]
            if query.limit:
                events = events[: query.limit]

        return events

    async def get_metrics(
        self, start: int, end: int
    ) -> SecurityMetrics:
        """Get security metrics for a time range.
        
        Args:
            start: Start timestamp
            end: End timestamp
            
        Returns:
            Security metrics
        """
        # Query events in range
        query = EventQuery(startDate=start, endDate=end)
        events = await self.query_events(query)

        # Calculate metrics
        total_events = len(events)

        # Events by type
        type_counter = Counter(e.type.value for e in events)
        events_by_type = dict(type_counter)

        # Events by severity
        severity_counter = Counter(e.severity.value for e in events)
        events_by_severity = dict(severity_counter)

        # Top IPs
        ip_counter = Counter(e.ip for e in events)
        top_ips = [{"ip": ip, "count": count} for ip, count in ip_counter.most_common(10)]

        # Top users
        user_counter = Counter(e.user_id for e in events if e.user_id)
        top_users = [
            {"userId": user_id, "count": count} for user_id, count in user_counter.most_common(10)
        ]

        return SecurityMetrics(
            timeRange={"start": start, "end": end},
            totalEvents=total_events,
            eventsByType=events_by_type,
            eventsBySeverity=events_by_severity,
            topIPs=top_ips,
            topUsers=top_users,
        )

    async def resolve_event(
        self, event_id: str, resolved_by: str, notes: Optional[str] = None
    ) -> None:
        """Mark an event as resolved.
        
        Args:
            event_id: Event ID
            resolved_by: User resolving the event
            notes: Resolution notes
        """
        event_data = await self.storage.get("events", event_id)
        if event_data:
            event = SecurityEvent(**event_data)
            event.resolved = True
            event.resolved_at = int(time.time() * 1000)
            event.resolved_by = resolved_by
            event.notes = notes
            await self.storage.save_event(event)
