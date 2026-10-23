/**
 * Size limiting utilities
 */

import { estimateSize, truncateString, trimArray } from "./serialization.js";

/**
 * Limit the size of a payload
 */
export function limitPayloadSize(payload: any, maxSize: number): any {
  const currentSize = estimateSize(payload);

  if (currentSize <= maxSize) {
    return payload;
  }

  // Try reducing arrays
  const limited = { ...payload };

  if (Array.isArray(limited.breadcrumbs) && limited.breadcrumbs.length > 10) {
    limited.breadcrumbs = trimArray(limited.breadcrumbs, 10);
  }

  if (Array.isArray(limited.consoleLogs) && limited.consoleLogs.length > 20) {
    limited.consoleLogs = trimArray(limited.consoleLogs, 20);
  }

  if (
    Array.isArray(limited.networkRequests) &&
    limited.networkRequests.length > 5
  ) {
    limited.networkRequests = trimArray(limited.networkRequests, 5);
  }

  // Truncate long strings
  if (
    typeof limited.description === "string" &&
    limited.description.length > 1000
  ) {
    limited.description = truncateString(limited.description, 1000);
  }

  // Check size again
  const newSize = estimateSize(limited);

  if (newSize <= maxSize) {
    return limited;
  }

  // Last resort: remove non-essential fields
  delete limited.consoleLogs;
  delete limited.networkRequests;

  return limited;
}
