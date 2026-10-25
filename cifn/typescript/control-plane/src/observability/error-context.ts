import { AsyncLocalStorage } from 'node:async_hooks';
/** Request-local fixed code only; never store errors, headers, bodies or URLs. */
export const errorContext = new AsyncLocalStorage<{ code?: string }>();
export function noteErrorCode(code: string): void { const context = errorContext.getStore(); if (context) context.code = code; }
export const TELEMETRY_ERROR_CODES = [
  'CLAIM_CONFLICT', 'UNAVAILABLE', 'PAYLOAD_TOO_LARGE', 'BAD_REQUEST', 'UNAUTHORIZED',
  'RUNNER_TOKEN_INVALID', 'PIPELINE_INVALID', 'RUN_CREATE_FAILED', 'RUN_NOT_FOUND',
  'RUN_ALREADY_FINISHED', 'RUNNER_NOT_FOUND', 'INTERNAL_ERROR', 'UNCLASSIFIED_ERROR',
] as const;
export const TELEMETRY_ROUTES = [
  '/api/v1/runs', '/api/v1/runs/:runId', '/api/v1/runs/:runId/cancel',
  '/api/v1/runs/:runId/jobs/:jobKey/logs', '/api/v1/runs/:runId/artifacts',
  '/api/v1/runners/register', '/api/v1/runners/heartbeat',
  ...['resume', 'ack', 'complete', 'status', 'stopped', 'logs', 'step'].map(action => `/api/v1/runners/claims/${action}`),
  '/webhooks/github', 'unmatched',
];
export interface ApiErrorTelemetry { code: string; route: string; method: string; status: number }
export function validateApiErrorTelemetry(event: ApiErrorTelemetry): void {
  if (!event || Object.keys(event).sort().join(',') !== 'code,method,route,status' ||
    !TELEMETRY_ERROR_CODES.includes(event.code as typeof TELEMETRY_ERROR_CODES[number]) ||
    !TELEMETRY_ROUTES.includes(event.route) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'OTHER'].includes(event.method) ||
    !Number.isInteger(event.status) || event.status < 400 || event.status > 599) throw new Error('Invalid API error telemetry');
}
