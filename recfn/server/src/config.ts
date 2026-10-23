/**
 * Server configuration with limit defaults.
 * Load from env: RECFN_MAX_*, RECFN_RATE_LIMIT_*.
 */

import { readIntEnvOrDefault } from '@superfunctions/config';

export interface RecFnLimitsConfig {
  maxConcurrentBots: number;
  maxRecordingDurationMs: number;
  maxTranscriptSegments: number;
  maxWebSocketConnectionsPerBot: number;
  maxWebhooksPerNamespace: number;
  maxCalendarsPerNamespace: number;
  paginationMaxLimit: number;
  searchQueryMaxLength: number;
}

export interface RecFnRateLimitConfig {
  requestsPerSecond: number;
  windowMs: number;
}

export const DEFAULT_LIMITS: RecFnLimitsConfig = {
  maxConcurrentBots: 100,
  maxRecordingDurationMs: 8 * 60 * 60 * 1000,
  maxTranscriptSegments: 100_000,
  maxWebSocketConnectionsPerBot: 50,
  maxWebhooksPerNamespace: 20,
  maxCalendarsPerNamespace: 10,
  paginationMaxLimit: 100,
  searchQueryMaxLength: 500,
};

export const DEFAULT_RATE_LIMIT: RecFnRateLimitConfig = {
  requestsPerSecond: 100,
  windowMs: 1000,
};

function envInt(name: string, defaultVal: number): number {
  // Deterministic fallback strategy for malformed/out-of-range env values.
  return readIntEnvOrDefault(name, {
    defaultValue: defaultVal,
    min: 1,
  });
}

export function loadLimitsConfig(): RecFnLimitsConfig {
  return {
    maxConcurrentBots: envInt('RECFN_MAX_CONCURRENT_BOTS', DEFAULT_LIMITS.maxConcurrentBots),
    maxRecordingDurationMs: envInt('RECFN_MAX_RECORDING_DURATION_MS', DEFAULT_LIMITS.maxRecordingDurationMs),
    maxTranscriptSegments: envInt('RECFN_MAX_TRANSCRIPT_SEGMENTS', DEFAULT_LIMITS.maxTranscriptSegments),
    maxWebSocketConnectionsPerBot: envInt('RECFN_MAX_WS_CONNECTIONS_PER_BOT', DEFAULT_LIMITS.maxWebSocketConnectionsPerBot),
    maxWebhooksPerNamespace: envInt('RECFN_MAX_WEBHOOKS_PER_NAMESPACE', DEFAULT_LIMITS.maxWebhooksPerNamespace),
    maxCalendarsPerNamespace: envInt('RECFN_MAX_CALENDARS_PER_NAMESPACE', DEFAULT_LIMITS.maxCalendarsPerNamespace),
    paginationMaxLimit: envInt('RECFN_PAGINATION_MAX_LIMIT', DEFAULT_LIMITS.paginationMaxLimit),
    searchQueryMaxLength: envInt('RECFN_SEARCH_QUERY_MAX_LENGTH', DEFAULT_LIMITS.searchQueryMaxLength),
  };
}

export function loadRateLimitConfig(): RecFnRateLimitConfig {
  return {
    requestsPerSecond: envInt('RECFN_RATE_LIMIT_REQUESTS_PER_SECOND', DEFAULT_RATE_LIMIT.requestsPerSecond),
    windowMs: envInt('RECFN_RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT.windowMs),
  };
}
