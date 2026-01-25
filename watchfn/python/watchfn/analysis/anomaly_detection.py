"""Anomaly detection for insights."""

from typing import List, Literal
from dataclasses import dataclass


@dataclass
class DataPoint:
    timestamp: float
    value: float


@dataclass
class Anomaly:
    timestamp: float
    value: float
    expected: float
    deviation: float
    severity: Literal["low", "medium", "high"]
    type: Literal["spike", "drop", "trend_change"]


class AnomalyDetector:
    """Detect anomalies in time-series data."""
    
    def detect_moving_average(
        self,
        data: List[DataPoint],
        window_size: int = 10,
        threshold: float = 3.0
    ) -> List[Anomaly]:
        """Detect anomalies using moving average."""
        if len(data) < window_size:
            return []
        
        anomalies: List[Anomaly] = []
        
        for i in range(window_size, len(data)):
            window = data[i - window_size:i]
            values = [p.value for p in window]
            
            mean = sum(values) / len(values)
            variance = sum((x - mean) ** 2 for x in values) / len(values)
            stddev = variance ** 0.5
            
            current = data[i]
            z_score = abs(current.value - mean) / stddev if stddev > 0 else 0
            
            if z_score > threshold:
                deviation = current.value - mean
                anomalies.append(Anomaly(
                    timestamp=current.timestamp,
                    value=current.value,
                    expected=mean,
                    deviation=deviation,
                    severity=self._get_severity(z_score),
                    type="spike" if deviation > 0 else "drop"
                ))
        
        return anomalies
    
    def _get_severity(self, z_score: float) -> Literal["low", "medium", "high"]:
        """Get severity based on z-score."""
        if z_score < 2:
            return "low"
        elif z_score < 4:
            return "medium"
        else:
            return "high"
