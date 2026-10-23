"""Alert manager for Python."""

from typing import List, Dict, Any, Optional, Literal
from dataclasses import dataclass
import time
import threading
from .observations import validate, evaluate as evaluate_stored, ranges
from ..query import number
from .conditions import ConditionEvaluator


@dataclass
class Alert:
    id: str
    name: str
    description: Optional[str]
    enabled: bool
    condition: Dict[str, Any]
    severity: Literal["info", "warning", "error", "critical"]
    channels: List[str]
    state: Literal["normal", "triggered", "acknowledged", "resolved"] = "normal"
    triggered_at: Optional[float] = None
    last_evaluated: Optional[float] = None
    consecutive_failures: int = 0
    auto_resolve: Optional[Dict[str, Any]] = None


@dataclass
class EvaluationResult:
    alert: Alert
    triggered: bool
    timestamp: float
    value: Optional[float] = None
    message: Optional[str] = None
    matched: Optional[bool] = None
    observed: bool = False


class AlertManager:
    """Manage alerts and evaluate conditions."""
    
    def __init__(self, snapshot=None):
        self.alerts: Dict[str, Alert] = {}
        self.evaluator = ConditionEvaluator()
        self._snapshot = snapshot
        self._evaluation_lock = threading.Lock()
    
    def evaluate_stored(self, *, now=None, maximum=10000) -> List[EvaluationResult]:
        """Evaluate owned storage explicitly; definitions/state remain process-local.

        Unlike the legacy array API, only explicit auto_resolve can recover a
        triggered alert. Storage/validation failures leave all states unchanged.
        """
        if self._snapshot is None:
            raise RuntimeError("Stored evaluation requires a WatchFn-owned alert manager")
        now = time.time() * 1000 if now is None else now
        if not number(now): raise ValueError("Evaluation time must be finite")
        if type(maximum) is not int or not 1 <= maximum <= 1000000:
            raise ValueError("Observation capacity must be 1..1000000")
        with self._evaluation_lock:
            alerts = [alert for alert in self.alerts.values() if alert.enabled]
            requested = {}
            for alert in alerts:
                validate(alert.condition)
                ranges(alert.condition, now, requested)
                if alert.auto_resolve is not None:
                    if not isinstance(alert.auto_resolve, dict) or type(alert.auto_resolve.get("enabled")) is not bool:
                        raise ValueError("Invalid auto_resolve configuration")
                    if alert.auto_resolve["enabled"]:
                        validate(alert.auto_resolve.get("condition"))
                        ranges(alert.auto_resolve["condition"], now, requested)
            data = self._snapshot(requested, now, maximum)
            evaluated = [(alert, evaluate_stored(alert.condition, data, now),
                evaluate_stored(alert.auto_resolve["condition"], data, now)
                if alert.auto_resolve and alert.auto_resolve["enabled"] else None) for alert in alerts]
            results = []
            for alert, matched, recovery in evaluated:
                if alert.last_evaluated is not None and now < alert.last_evaluated:
                    raise ValueError("Evaluation time must not move backwards")
            for alert, matched, recovery in evaluated:
                if matched is True:
                    alert.consecutive_failures += 1
                    if alert.state == "normal":
                        alert.state = "triggered"
                        alert.triggered_at = now
                if alert.state == "triggered" and recovery is True:
                    alert.state = "normal"
                    alert.triggered_at = None
                    alert.consecutive_failures = 0
                alert.last_evaluated = now
                results.append(EvaluationResult(alert, matched is True, now, matched=matched, observed=matched is not None))
            return results

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
