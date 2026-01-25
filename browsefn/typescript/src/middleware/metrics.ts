/**
 * Metrics collection middleware
 */

import type { Metrics, ProviderMetrics } from '../core/types.js';

interface MetricEntry {
  provider: string;
  success: boolean;
  duration: number;
  timestamp: number;
}

export class MetricsCollector {
  private metrics: MetricEntry[] = [];

  /**
   * Record a metric
   */
  record(provider: string, success: boolean, duration: number): void {
    this.metrics.push({
      provider,
      success,
      duration,
      timestamp: Date.now()
    });

    // Keep only last 10000 metrics
    if (this.metrics.length > 10000) {
      this.metrics.shift();
    }
  }

  /**
   * Get metrics
   */
  getMetrics(options?: {
    timeRange?: 'last-hour' | 'last-24h' | 'last-7d' | 'all';
    groupBy?: 'provider';
  }): Metrics {
    let filtered = [...this.metrics];

    // Filter by time range
    if (options?.timeRange && options.timeRange !== 'all') {
      const now = Date.now();
      let cutoff = 0;

      switch (options.timeRange) {
        case 'last-hour':
          cutoff = now - 3600000;
          break;
        case 'last-24h':
          cutoff = now - 86400000;
          break;
        case 'last-7d':
          cutoff = now - 604800000;
          break;
      }

      filtered = filtered.filter(m => m.timestamp >= cutoff);
    }

    const totalRequests = filtered.length;
    const successCount = filtered.filter(m => m.success).length;
    const totalDuration = filtered.reduce((sum, m) => sum + m.duration, 0);

    // Group by provider
    const byProvider = new Map<string, ProviderMetrics>();

    for (const metric of filtered) {
      if (!byProvider.has(metric.provider)) {
        byProvider.set(metric.provider, {
          name: metric.provider,
          requests: 0,
          successes: 0,
          failures: 0,
          avgResponseTime: 0
        });
      }

      const pm = byProvider.get(metric.provider)!;
      pm.requests++;
      if (metric.success) {
        pm.successes++;
      } else {
        pm.failures++;
      }
    }

    // Calculate average response times
    for (const [provider, pm] of byProvider) {
      const providerMetrics = filtered.filter(m => m.provider === provider);
      const totalTime = providerMetrics.reduce((sum, m) => sum + m.duration, 0);
      pm.avgResponseTime = totalTime / providerMetrics.length;
    }

    return {
      totalRequests,
      successRate: totalRequests > 0 ? (successCount / totalRequests) * 100 : 0,
      avgResponseTime: totalRequests > 0 ? totalDuration / totalRequests : 0,
      byProvider: Array.from(byProvider.values())
    };
  }

  /**
   * Clear metrics
   */
  clear(): void {
    this.metrics = [];
  }
}
