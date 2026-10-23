export type SamplingStrategy = "fixed" | "adaptive" | "level-based";

export interface SamplingConfig {
  strategy: SamplingStrategy;
  baseRate?: number;
  errorRate?: number;
  slowRate?: number;
  slowThreshold?: number;
  rates?: Record<string, number>;
}

export class Sampler {
  private config: SamplingConfig;
  private counter = 0;

  constructor(config: SamplingConfig) {
    this.config = {
      baseRate: 1.0,
      errorRate: 1.0,
      slowRate: 1.0,
      slowThreshold: 1000,
      ...config,
    };
  }

  /**
   * Determine if an event should be sampled
   */
  shouldSample(event: {
    type?: string;
    level?: string;
    duration?: number;
    error?: boolean;
  }): boolean {
    switch (this.config.strategy) {
      case "fixed":
        return this.fixedSample(this.config.baseRate!);

      case "adaptive":
        return this.adaptiveSample(event);

      case "level-based":
        return this.levelBasedSample(event.level || "info");

      default:
        return true;
    }
  }

  /**
   * Fixed rate sampling
   */
  private fixedSample(rate: number): boolean {
    if (rate >= 1.0) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
  }

  /**
   * Adaptive sampling based on event characteristics
   */
  private adaptiveSample(event: {
    type?: string;
    duration?: number;
    error?: boolean;
  }): boolean {
    // Always sample errors
    if (event.error) {
      return this.fixedSample(this.config.errorRate!);
    }

    // Always sample slow requests
    if (
      event.duration !== undefined &&
      event.duration > this.config.slowThreshold!
    ) {
      return this.fixedSample(this.config.slowRate!);
    }

    // Use base rate for normal events
    return this.fixedSample(this.config.baseRate!);
  }

  /**
   * Level-based sampling (e.g., for logs)
   */
  private levelBasedSample(level: string): boolean {
    if (!this.config.rates) {
      return true;
    }

    const rate = this.config.rates[level.toLowerCase()];
    if (rate === undefined) {
      return this.fixedSample(this.config.baseRate!);
    }

    return this.fixedSample(rate);
  }

  /**
   * Deterministic sampling based on a key (for trace sampling)
   */
  shouldSampleDeterministic(key: string, rate: number): boolean {
    if (rate >= 1.0) return true;
    if (rate <= 0) return false;

    // Use hash of key to determine sampling
    const hash = this.hashString(key);
    const threshold = rate * Number.MAX_SAFE_INTEGER;
    return hash < threshold;
  }

  /**
   * Simple string hash function
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Get sample rate for an event type
   */
  getSampleRate(eventType: string): number {
    if (this.config.strategy === "level-based" && this.config.rates) {
      return (
        this.config.rates[eventType.toLowerCase()] || this.config.baseRate!
      );
    }
    return this.config.baseRate!;
  }

  /**
   * Update sampling configuration
   */
  updateConfig(config: Partial<SamplingConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Create a sampler from configuration
 */
export function createSampler(config: SamplingConfig): Sampler {
  return new Sampler(config);
}

/**
 * Default samplers for common use cases
 */
export const DefaultSamplers = {
  /**
   * Sample all events (no sampling)
   */
  all: (): Sampler =>
    new Sampler({
      strategy: "fixed",
      baseRate: 1.0,
    }),

  /**
   * Sample 10% of events
   */
  tenPercent: (): Sampler =>
    new Sampler({
      strategy: "fixed",
      baseRate: 0.1,
    }),

  /**
   * Adaptive sampling for traces
   */
  adaptiveTraces: (): Sampler =>
    new Sampler({
      strategy: "adaptive",
      baseRate: 0.1,
      errorRate: 1.0,
      slowRate: 1.0,
      slowThreshold: 1000,
    }),

  /**
   * Level-based sampling for logs
   */
  logLevels: (): Sampler =>
    new Sampler({
      strategy: "level-based",
      rates: {
        error: 1.0,
        warn: 0.5,
        info: 0.1,
        debug: 0.01,
      },
    }),
};
