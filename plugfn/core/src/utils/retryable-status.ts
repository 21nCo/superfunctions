const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}
