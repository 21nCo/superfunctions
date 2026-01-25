// Business metrics and KPI tracking

export interface BusinessEvent {
  name: string;
  timestamp: number;
  properties: Record<string, any>;
  userId?: string;
  value?: number;
}

export interface KPI {
  name: string;
  value: number;
  target?: number;
  timestamp: number;
  trend?: "up" | "down" | "flat";
}

export interface FunnelStep {
  name: string;
  event: string;
  filters?: Record<string, any>;
}

export interface Funnel {
  name: string;
  steps: FunnelStep[];
  timeWindow: number; // ms - users must complete all steps within this time
}

export class BusinessMetricsTracker {
  private events: BusinessEvent[] = [];
  private funnels: Map<string, Funnel> = new Map();
  private maxEvents: number;

  constructor(options: { maxEvents?: number } = {}) {
    this.maxEvents = options.maxEvents || 1000000;
  }

  /**
   * Track a business event
   */
  track(event: Omit<BusinessEvent, "timestamp">): BusinessEvent {
    const businessEvent: BusinessEvent = {
      ...event,
      timestamp: Date.now(),
    };

    this.events.push(businessEvent);

    // Keep only recent events
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    return businessEvent;
  }

  /**
   * Create a conversion funnel
   */
  createFunnel(funnel: Funnel): void {
    this.funnels.set(funnel.name, funnel);
  }

  /**
   * Analyze funnel conversion
   */
  analyzeFunnel(
    funnelName: string,
    from: number,
    to: number
  ): {
    steps: Array<{ name: string; count: number; conversionRate: number }>;
    overallConversion: number;
  } | null {
    const funnel = this.funnels.get(funnelName);
    if (!funnel) {
      return null;
    }

    const events = this.events.filter(
      (e) => e.timestamp >= from && e.timestamp <= to
    );

    const stepResults: Array<{
      name: string;
      count: number;
      conversionRate: number;
    }> = [];
    let previousCount = 0;

    for (let i = 0; i < funnel.steps.length; i++) {
      const step = funnel.steps[i];

      // Count users who reached this step
      const stepEvents = events.filter((e) => {
        if (e.name !== step.event) return false;

        if (step.filters) {
          return Object.entries(step.filters).every(
            ([key, value]) => e.properties[key] === value
          );
        }

        return true;
      });

      const count = new Set(stepEvents.map((e) => e.userId)).size;
      const conversionRate =
        previousCount > 0 ? (count / previousCount) * 100 : 100;

      stepResults.push({
        name: step.name,
        count,
        conversionRate,
      });

      previousCount = count || stepResults[0].count;
    }

    const overallConversion =
      stepResults.length > 0
        ? (stepResults[stepResults.length - 1].count / stepResults[0].count) *
          100
        : 0;

    return {
      steps: stepResults,
      overallConversion,
    };
  }

  /**
   * Calculate KPI
   */
  calculateKPI(
    name: string,
    config: {
      event: string;
      aggregation: "count" | "sum" | "avg";
      valueField?: string;
      from: number;
      to: number;
      target?: number;
    }
  ): KPI {
    const events = this.events.filter(
      (e) =>
        e.name === config.event &&
        e.timestamp >= config.from &&
        e.timestamp <= config.to
    );

    let value: number;

    switch (config.aggregation) {
      case "count":
        value = events.length;
        break;
      case "sum":
        value = events.reduce(
          (sum, e) => sum + (e.properties[config.valueField!] || 0),
          0
        );
        break;
      case "avg":
        const values = events.map((e) => e.properties[config.valueField!] || 0);
        value =
          values.length > 0
            ? values.reduce((sum, v) => sum + v, 0) / values.length
            : 0;
        break;
      default:
        value = 0;
    }

    return {
      name,
      value,
      target: config.target,
      timestamp: Date.now(),
      trend: this.calculateTrend(name, value, config.from, config.to),
    };
  }

  /**
   * Get revenue metrics
   */
  getRevenue(
    from: number,
    to: number,
    groupBy?: string
  ): Array<{ group?: string; revenue: number }> {
    const revenueEvents = this.events.filter(
      (e) => e.value !== undefined && e.timestamp >= from && e.timestamp <= to
    );

    if (!groupBy) {
      const total = revenueEvents.reduce((sum, e) => sum + (e.value || 0), 0);
      return [{ revenue: total }];
    }

    const groups = new Map<string, number>();
    for (const event of revenueEvents) {
      const group = event.properties[groupBy] || "unknown";
      groups.set(group, (groups.get(group) || 0) + (event.value || 0));
    }

    return Array.from(groups.entries()).map(([group, revenue]) => ({
      group,
      revenue,
    }));
  }

  private calculateTrend(
    name: string,
    currentValue: number,
    from: number,
    to: number
  ): "up" | "down" | "flat" {
    // Calculate previous period value
    const duration = to - from;
    const previousFrom = from - duration;
    const previousTo = from;

    const previousEvents = this.events.filter(
      (e) =>
        e.name === name &&
        e.timestamp >= previousFrom &&
        e.timestamp < previousTo
    );

    const previousValue = previousEvents.length;

    if (currentValue > previousValue * 1.05) return "up";
    if (currentValue < previousValue * 0.95) return "down";
    return "flat";
  }
}
