/**
 * Sampling pipeline stage
 */

import type { LogEvent, LogLevel, PipelineStage } from "../types.js";

/**
 * Sampling rates per log level (0-1, where 1 = keep all)
 */
export type SamplingRates = Partial<Record<LogLevel, number>>;

/**
 * Default sampling rates
 */
const DEFAULT_RATES: SamplingRates = {
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
export function sample(rates: SamplingRates = {}): PipelineStage {
  const mergedRates = { ...DEFAULT_RATES, ...rates };

  return (event: LogEvent): LogEvent | null => {
    const rate = mergedRates[event.level] ?? 1.0;

    // Always keep if rate is 1
    if (rate >= 1.0) {
      return event;
    }

    // Always drop if rate is 0
    if (rate <= 0.0) {
      return null;
    }

    // Sample based on rate
    if (Math.random() < rate) {
      return event;
    }

    return null; // Drop event
  };
}
