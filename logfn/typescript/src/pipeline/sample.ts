/**
 * Sampling pipeline stage
 */

import type { LogEvent, LogLevel, PipelineStage } from "../types.js";

/**
 * Sampling rates per log level (0-1, where 1 = keep all)
 */
export type SamplingRates = Partial<Record<LogLevel, number>>;

/**
 * Sampling options
 */
export interface SamplingOptions {
  /** Random source returning a number in [0, 1) (default: Math.random) */
  random?: () => number;
}

/**
 * Default sampling rates
 */
export const DEFAULT_SAMPLING_RATES: Readonly<Record<LogLevel, number>> = {
  error: 1.0,
  fatal: 1.0,
  warn: 1.0,
  info: 0.1,
  debug: 0.01,
  trace: 0.0,
};

/**
 * Create a sampling pipeline stage
 * Returns null to drop events based on sampling rate
 */
export function sample(rates: SamplingRates = {}, options: SamplingOptions = {}): PipelineStage {
  const mergedRates: SamplingRates = { ...DEFAULT_SAMPLING_RATES, ...rates };
  const random = options.random ?? Math.random;

  return function sampleStage(event: LogEvent): LogEvent | null {
    const rate = mergedRates[event.level] ?? 1.0;

    // Always keep if rate is 1
    if (rate >= 1.0) {
      return event;
    }

    // Always drop if rate is 0 (or not a number)
    if (!(rate > 0.0)) {
      return null;
    }

    // Sample based on rate
    return random() < rate ? event : null;
  };
}
