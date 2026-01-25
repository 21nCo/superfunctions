"""Alert manager for Python."""

from typing import List, Dict, Any, Optional, Literal
from dataclasses import dataclass
import time
from .conditions import ConditionEvaluator


@dataclass
class Alert:
    id: str
    name: str
    description: Optional[str]
    enabled: bool
    condition: Dict[str, Any]
    severity: Literal["info", "warning", "critical"]
    channels: List[str]
    state: Literal["normal", "triggered"] = "normal"
    triggered_at: Optional[float] = None
    last_evaluated: Optional[float] = None
    consecutive_failures: int = 0


@dataclass
class EvaluationResult:
    alert: Alert
    triggered: bool
    timestamp: float
    value: Optional[float] = None
    message: Optional[str] = None


class AlertManager:
    """Manage alerts and evaluate conditions."""
    
    def __init__(self):
        self.alerts: Dict[str, Alert] = {}
        self.evaluator = ConditionEvaluator()
    
    def register(self, alert: Alert) -> None:
        """Register an alert."""
        alert.state = "normal"
        alert.consecutive_failures = 0
        self.alerts[alert.id] = alert
    
    def evaluate_all(self, data: Dict[str, List[Any]]) -> List[EvaluationResult]:
        """Evaluate all alerts."""
        results: List[EvaluationResult] = []
        
        for alert in self.alerts.values():
            if not alert.enabled:
                continue
            
            result = self.evaluate(alert, data)
            results.append(result)
        
        return results
    
    def evaluate(self, alert: Alert, data: Dict[str, List[Any]]) -> EvaluationResult:
        """Evaluate a single alert."""
        timestamp = time.time() * 1000
        
        # Get relevant data
        alert_data = self._get_alert_data(alert, data)
        
        # Evaluate condition
        triggered = self.evaluator.evaluate(alert.condition, alert_data)
        
        # Update alert state
        if triggered:
            alert.consecutive_failures += 1
            if alert.state == "normal":
                alert.state = "triggered"
                alert.triggered_at = timestamp
        else:
            alert.consecutive_failures = 0
            if alert.state == "triggered":
                alert.state = "normal"
                alert.triggered_at = None
        
        alert.last_evaluated = timestamp
        
        return EvaluationResult(
            alert=alert,
            triggered=triggered,
            timestamp=timestamp,
            message=f"Alert {alert.name} triggered" if triggered else None
        )
    
    def get(self, alert_id: str) -> Optional[Alert]:
        """Get alert by ID."""
        return self.alerts.get(alert_id)
    
    def get_all(self) -> List[Alert]:
        """Get all alerts."""
        return list(self.alerts.values())
    
    def get_triggered(self) -> List[Alert]:
        """Get all triggered alerts."""
        return [a for a in self.alerts.values() if a.state == "triggered"]
    
    def disable(self, alert_id: str) -> None:
        """Disable an alert."""
        if alert_id in self.alerts:
            self.alerts[alert_id].enabled = False
    
    def enable(self, alert_id: str) -> None:
        """Enable an alert."""
        if alert_id in self.alerts:
            self.alerts[alert_id].enabled = True
    
    def remove(self, alert_id: str) -> None:
        """Remove an alert."""
        if alert_id in self.alerts:
            del self.alerts[alert_id]
    
    def _get_alert_data(self, alert: Alert, all_data: Dict[str, List[Any]]) -> List[Any]:
        """Get data for alert condition."""
        metric = self._extract_metric(alert.condition)
        return all_data.get(metric, [])
    
    def _extract_metric(self, condition: Dict[str, Any]) -> str:
        """Extract metric name from condition."""
        if condition.get("type") in ["threshold", "anomaly"]:
            return condition.get("metric", "")
        elif condition.get("type") == "composite":
            for cond in condition.get("conditions", []):
                metric = self._extract_metric(cond)
                if metric:
                    return metric
        return ""
