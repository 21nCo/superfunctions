// Anomaly detection for automated insights

export interface DataPoint {
  timestamp: number;
  value: number;
}

export interface Anomaly {
  timestamp: number;
  value: number;
  expected: number;
  deviation: number;
  severity: "low" | "medium" | "high";
  type: "spike" | "drop" | "trend_change";
}

export class AnomalyDetector {
  /**
   * Detect anomalies using moving average
   */
  detectMovingAverage(
    data: DataPoint[],
    options: {
      windowSize?: number;
      threshold?: number; // Number of standard deviations
    } = {}
  ): Anomaly[] {
    const windowSize = options.windowSize || 10;
    const threshold = options.threshold || 3;

    if (data.length < windowSize) {
      return [];
    }

    const anomalies: Anomaly[] = [];

    for (let i = windowSize; i < data.length; i++) {
      const window = data.slice(i - windowSize, i);
      const mean = window.reduce((sum, d) => sum + d.value, 0) / window.length;
      const variance =
        window.reduce((sum, d) => sum + Math.pow(d.value - mean, 2), 0) /
        window.length;
      const stdDev = Math.sqrt(variance);

      const current = data[i];
      const zScore = (current.value - mean) / stdDev;

      if (Math.abs(zScore) > threshold) {
        const deviation = current.value - mean;
        const anomaly: Anomaly = {
          timestamp: current.timestamp,
          value: current.value,
          expected: mean,
          deviation,
          severity: this.getSeverity(Math.abs(zScore)),
          type: deviation > 0 ? "spike" : "drop",
        };
        anomalies.push(anomaly);
      }
    }

    return anomalies;
  }

  /**
   * Detect seasonal anomalies
   */
  detectSeasonal(
    data: DataPoint[],
    seasonalPeriod: number, // Number of data points in a season
    threshold: number = 2
  ): Anomaly[] {
    if (data.length < seasonalPeriod * 2) {
      return [];
    }

    const anomalies: Anomaly[] = [];

    for (let i = seasonalPeriod; i < data.length; i++) {
      // Get historical values for this position in the season
      const historicalValues: number[] = [];
      for (let j = i % seasonalPeriod; j < i; j += seasonalPeriod) {
        historicalValues.push(data[j].value);
      }

      if (historicalValues.length < 2) continue;

      const mean =
        historicalValues.reduce((sum, v) => sum + v, 0) /
        historicalValues.length;
      const variance =
        historicalValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
        historicalValues.length;
      const stdDev = Math.sqrt(variance);

      const current = data[i];
      const zScore = (current.value - mean) / stdDev;

      if (Math.abs(zScore) > threshold) {
        const deviation = current.value - mean;
        anomalies.push({
          timestamp: current.timestamp,
          value: current.value,
          expected: mean,
          deviation,
          severity: this.getSeverity(Math.abs(zScore)),
          type: deviation > 0 ? "spike" : "drop",
        });
      }
    }

    return anomalies;
  }

  /**
   * Detect trend changes
   */
  detectTrendChanges(data: DataPoint[], windowSize: number = 7): Anomaly[] {
    if (data.length < windowSize * 2) {
      return [];
    }

    const anomalies: Anomaly[] = [];

    for (let i = windowSize * 2; i < data.length; i++) {
      const oldWindow = data.slice(i - windowSize * 2, i - windowSize);
      const newWindow = data.slice(i - windowSize, i);

      const oldTrend = this.calculateTrend(oldWindow);
      const newTrend = this.calculateTrend(newWindow);

      // Detect significant trend change
      const trendChange = Math.abs(newTrend - oldTrend);
      if (trendChange > 0.5) {
        // Arbitrary threshold
        anomalies.push({
          timestamp: data[i].timestamp,
          value: data[i].value,
          expected: data[i - 1].value,
          deviation: newTrend - oldTrend,
          severity: this.getSeverity(trendChange * 2),
          type: "trend_change",
        });
      }
    }

    return anomalies;
  }

  private calculateTrend(data: DataPoint[]): number {
    // Simple linear regression slope
    const n = data.length;
    const sumX = data.reduce((sum, _, i) => sum + i, 0);
    const sumY = data.reduce((sum, d) => sum + d.value, 0);
    const sumXY = data.reduce((sum, d, i) => sum + i * d.value, 0);
    const sumX2 = data.reduce((sum, _, i) => sum + i * i, 0);

    return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  }

  private getSeverity(zScore: number): "low" | "medium" | "high" {
    if (zScore < 2) return "low";
    if (zScore < 4) return "medium";
    return "high";
  }
}
