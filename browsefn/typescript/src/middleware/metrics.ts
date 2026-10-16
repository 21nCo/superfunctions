/**
 * Metrics collection middleware.
 */

import type { Metrics, ProviderMetrics } from '../core/types.js';

interface MetricEntry {
  provider: string;
  success: boolean;
  duration: number;
  timestamp: number;
  cached: boolean;
}

export class MetricsCollector {
  private metrics: MetricEntry[] = [];

  record(input: {
    provider?: string;
    success: boolean;
    duration: number;
    cached?: boolean;
  }): void {
    this.metrics.push({
      provider: input.provider ?? 'unknown',
      success: input.success,
      duration: input.duration,
      timestamp: Date.now(),
      cached: input.cached === true,
    });

    if (this.metrics.length > 10_000) {
      this.metrics.shift();
    }
  }

  getMetrics(options?: {
    timeRange?: 'last-hour' | 'last-24h' | 'last-7d' | 'all';
    groupBy?: 'provider';
  }): Metrics {
    let filtered = [...this.metrics];

    if (options?.timeRange && options.timeRange !== 'all') {
      const now = Date.now();
      let cutoff = 0;

      switch (options.timeRange) {
        case 'last-hour':
          cutoff = now - 3_600_000;
          break;
        case 'last-24h':
          cutoff = now - 86_400_000;
          break;
        case 'last-7d':
          cutoff = now - 604_800_000;
          break;
      }

      filtered = filtered.filter((metric) => metric.timestamp >= cutoff);
    }

    const totalRequests = filtered.length;
    const successCount = filtered.filter((metric) => metric.success).length;
    const totalDuration = filtered.reduce((sum, metric) => sum + metric.duration, 0);
    const cacheHits = filtered.filter((metric) => metric.cached).length;

    const byProvider = new Map<string, ProviderMetrics>();

    for (const metric of filtered) {
      if (!byProvider.has(metric.provider)) {
        byProvider.set(metric.provider, {
          name: metric.provider,
          requests: 0,
          successes: 0,
          failures: 0,
          avgResponseTime: 0,
        });
      }

      const providerMetric = byProvider.get(metric.provider)!;
      providerMetric.requests += 1;
      if (metric.success) {
        providerMetric.successes += 1;
      } else {
        providerMetric.failures += 1;
      }
    }

    for (const [provider, providerMetric] of byProvider) {
      const providerEntries = filtered.filter((metric) => metric.provider === provider);
      const providerDuration = providerEntries.reduce((sum, metric) => sum + metric.duration, 0);
      providerMetric.avgResponseTime =
        providerEntries.length > 0 ? providerDuration / providerEntries.length : 0;
    }

    return {
      totalRequests,
      successRate: totalRequests > 0 ? (successCount / totalRequests) * 100 : 0,
      avgResponseTime: totalRequests > 0 ? totalDuration / totalRequests : 0,
      cacheHitRate: totalRequests > 0 ? (cacheHits / totalRequests) * 100 : 0,
      byProvider: Array.from(byProvider.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    };
  }

  clear(): void {
    this.metrics = [];
  }
}
