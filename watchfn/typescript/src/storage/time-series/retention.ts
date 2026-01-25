export interface RetentionPolicy {
  name: string;
  duration: number; // milliseconds
  resolution?: string; // aggregation interval (e.g., "1h", "1d")
}

export interface RetentionRule {
  metric: string;
  policies: RetentionPolicy[];
}

export class RetentionManager {
  private rules: Map<string, RetentionPolicy[]> = new Map();
  private defaultPolicy: RetentionPolicy;

  constructor(defaultRetention: number = 30 * 24 * 60 * 60 * 1000) {
    // 30 days default
    this.defaultPolicy = {
      name: "default",
      duration: defaultRetention,
    };
  }

  /**
   * Add a retention rule for a metric
   */
  addRule(metric: string, policies: RetentionPolicy[]): void {
    this.rules.set(
      metric,
      policies.sort((a, b) => a.duration - b.duration)
    );
  }

  /**
   * Get retention policies for a metric
   */
  getPolicies(metric: string): RetentionPolicy[] {
    return this.rules.get(metric) || [this.defaultPolicy];
  }

  /**
   * Get the maximum retention duration for a metric
   */
  getMaxRetention(metric: string): number {
    const policies = this.getPolicies(metric);
    return Math.max(...policies.map((p) => p.duration));
  }

  /**
   * Determine which policy applies to a given age
   */
  getPolicyForAge(metric: string, ageMs: number): RetentionPolicy | null {
    const policies = this.getPolicies(metric);

    for (const policy of policies) {
      if (ageMs <= policy.duration) {
        return policy;
      }
    }

    return null; // Data should be deleted
  }

  /**
   * Check if data should be deleted
   */
  shouldDelete(metric: string, timestamp: number): boolean {
    const age = Date.now() - timestamp;
    const maxRetention = this.getMaxRetention(metric);
    return age > maxRetention;
  }

  /**
   * Get resolution (aggregation interval) for a given age
   */
  getResolution(metric: string, ageMs: number): string | undefined {
    const policy = this.getPolicyForAge(metric, ageMs);
    return policy?.resolution;
  }

  /**
   * Set default retention policy
   */
  setDefaultPolicy(duration: number, resolution?: string): void {
    this.defaultPolicy = {
      name: "default",
      duration,
      resolution,
    };
  }
}

/**
 * Common retention policies
 */
export const CommonPolicies = {
  /**
   * Keep raw data for 24 hours, 1-hour aggregates for 7 days, daily aggregates for 30 days
   */
  tiered: (): RetentionPolicy[] => [
    {
      name: "raw",
      duration: 24 * 60 * 60 * 1000, // 24 hours
    },
    {
      name: "hourly",
      duration: 7 * 24 * 60 * 60 * 1000, // 7 days
      resolution: "1h",
    },
    {
      name: "daily",
      duration: 30 * 24 * 60 * 60 * 1000, // 30 days
      resolution: "1d",
    },
  ],

  /**
   * Keep all data for 30 days
   */
  thirtyDays: (): RetentionPolicy[] => [
    {
      name: "30d",
      duration: 30 * 24 * 60 * 60 * 1000,
    },
  ],

  /**
   * Keep all data for 90 days
   */
  ninetyDays: (): RetentionPolicy[] => [
    {
      name: "90d",
      duration: 90 * 24 * 60 * 60 * 1000,
    },
  ],

  /**
   * Keep data for 1 year
   */
  oneYear: (): RetentionPolicy[] => [
    {
      name: "1y",
      duration: 365 * 24 * 60 * 60 * 1000,
    },
  ],
};
