/**
 * Limit enforcement helpers.
 * Used by route handlers to check limits before creating resources.
 */

import type { RecFnStore } from '../store/types.js';
import type { RecFnLimitsConfig } from '../config.js';
import { ErrorCode } from '@recfn/core';
import { createError } from '@recfn/core';

export async function checkWebhookCount(
  store: RecFnStore,
  namespace: string,
  limits: RecFnLimitsConfig,
): Promise<void> {
  const webhooks = await store.listWebhooks(namespace);
  if (webhooks.length >= limits.maxWebhooksPerNamespace) {
    throw createError(
      ErrorCode.BAD_REQUEST,
      `Maximum ${limits.maxWebhooksPerNamespace} webhooks per namespace.`,
      { limit: limits.maxWebhooksPerNamespace },
    );
  }
}

export async function checkCalendarCount(
  store: RecFnStore,
  namespace: string,
  limits: RecFnLimitsConfig,
): Promise<void> {
  const calendars = await store.listCalendars(namespace);
  if (calendars.length >= limits.maxCalendarsPerNamespace) {
    throw createError(
      ErrorCode.BAD_REQUEST,
      `Maximum ${limits.maxCalendarsPerNamespace} calendars per namespace.`,
      { limit: limits.maxCalendarsPerNamespace },
    );
  }
}

export function checkRecordingDuration(
  durationMs: number,
  limits: RecFnLimitsConfig,
): void {
  if (durationMs > limits.maxRecordingDurationMs) {
    throw createError(
      ErrorCode.BAD_REQUEST,
      `Recording duration exceeds maximum of ${limits.maxRecordingDurationMs / 3600000} hours.`,
      { maxDurationMs: limits.maxRecordingDurationMs },
    );
  }
}

export function checkTranscriptSegments(
  segmentCount: number,
  limits: RecFnLimitsConfig,
): void {
  if (segmentCount > limits.maxTranscriptSegments) {
    throw createError(
      ErrorCode.BAD_REQUEST,
      `Transcript exceeds maximum of ${limits.maxTranscriptSegments} segments.`,
      { limit: limits.maxTranscriptSegments },
    );
  }
}

export function checkSearchQueryLength(
  query: string,
  limits: RecFnLimitsConfig,
): void {
  if (query.length > limits.searchQueryMaxLength) {
    throw createError(
      ErrorCode.BAD_REQUEST,
      `Search query must be at most ${limits.searchQueryMaxLength} characters.`,
      { maxLength: limits.searchQueryMaxLength },
    );
  }
}

export function checkPaginationLimit(
  limit: number,
  limits: RecFnLimitsConfig,
): void {
  if (limit > limits.paginationMaxLimit || limit < 1) {
    throw createError(
      ErrorCode.BAD_REQUEST,
      `limit must be between 1 and ${limits.paginationMaxLimit}.`,
      { maxLimit: limits.paginationMaxLimit },
    );
  }
}
