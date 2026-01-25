"""Alert conditions and evaluation."""

from typing import List, Dict, Any, Literal, Optional
from dataclasses import dataclass


ConditionOperator = Literal["gt", "gte", "lt", "lte", "eq", "ne"]


@dataclass
class ThresholdCondition:
    type: Literal["threshold"] = "threshold"
    metric: str = ""
    operator: ConditionOperator = "gt"
    threshold: float = 0
    window: str = "5m"
    aggregation: Literal["avg", "sum", "min", "max", "count"] = "avg"


@dataclass
class AnomalyCondition:
    type: Literal["anomaly"] = "anomaly"
    metric: str = ""
    sensitivity: float = 0.8
    min_data_points: int = 10
    algorithm: Literal["moving-average", "stddev"] = "moving-average"


class ConditionEvaluator:
    """Evaluate alert conditions."""
    
    def evaluate(self, condition: Dict[str, Any], data: List[Any]) -> bool:
        """Evaluate an alert condition."""
        condition_type = condition.get("type")
        
        if condition_type == "threshold":
            return self._evaluate_threshold(condition, data)
        elif condition_type == "anomaly":
            return self._evaluate_anomaly(condition, data)
        elif condition_type == "composite":
            return self._evaluate_composite(condition, data)
        
        return False
    
    def _evaluate_threshold(self, condition: Dict[str, Any], data: List[Any]) -> bool:
        """Evaluate threshold condition."""
        if not data:
            return False
        
        values = [d.get("value", 0) for d in data]
        aggregation = condition.get("aggregation", "avg")
        
        if aggregation == "avg":
            value = sum(values) / len(values)
        elif aggregation == "sum":
            value = sum(values)
        elif aggregation == "min":
            value = min(values)
        elif aggregation == "max":
            value = max(values)
        elif aggregation == "count":
            value = len(values)
        else:
            value = 0
        
        operator = condition.get("operator", "gt")
        threshold = condition.get("threshold", 0)
        
        return self._compare_value(value, operator, threshold)
    
    def _evaluate_anomaly(self, condition: Dict[str, Any], data: List[Any]) -> bool:
        """Evaluate anomaly condition."""
        min_data_points = condition.get("min_data_points", 10)
        if len(data) < min_data_points:
            return False
        
        values = [d.get("value", 0) for d in data]
        current_value = values[-1]
        historical_values = values[:-1]
        
        algorithm = condition.get("algorithm", "moving-average")
        sensitivity = condition.get("sensitivity", 0.8)
        
        if algorithm == "moving-average":
            return self._detect_moving_average_anomaly(historical_values, current_value, sensitivity)
        elif algorithm == "stddev":
            return self._detect_stddev_anomaly(historical_values, current_value, sensitivity)
        
        return False
    
    def _evaluate_composite(self, condition: Dict[str, Any], data: List[Any]) -> bool:
        """Evaluate composite condition."""
        operator = condition.get("operator", "and")
        conditions = condition.get("conditions", [])
        
        results = [self.evaluate(c, data) for c in conditions]
        
        if operator == "and":
            return all(results)
        else:
            return any(results)
    
    def _compare_value(self, value: float, operator: str, threshold: float) -> bool:
        """Compare value against threshold."""
        if operator == "gt":
            return value > threshold
        elif operator == "gte":
            return value >= threshold
        elif operator == "lt":
            return value < threshold
        elif operator == "lte":
            return value <= threshold
        elif operator == "eq":
            return value == threshold
        elif operator == "ne":
            return value != threshold
        return False
    
    def _detect_moving_average_anomaly(self, historical: List[float], current: float, sensitivity: float) -> bool:
        """Detect anomaly using moving average."""
        if not historical:
            return False
        
        avg = sum(historical) / len(historical)
        deviation = abs(current - avg) / avg if avg != 0 else 0
        threshold = 1 - sensitivity
        
        return deviation > threshold
    
    def _detect_stddev_anomaly(self, historical: List[float], current: float, sensitivity: float) -> bool:
        """Detect anomaly using standard deviation."""
        if len(historical) < 2:
            return False
        
        mean = sum(historical) / len(historical)
        variance = sum((x - mean) ** 2 for x in historical) / len(historical)
        stddev = variance ** 0.5
        
        if stddev == 0:
            return False
        
        z_score = abs(current - mean) / stddev
        threshold = 3 - sensitivity * 2  # Range: 1 to 3 standard deviations
        
        return z_score > threshold
