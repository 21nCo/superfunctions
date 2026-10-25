import type { MiddlewareHandler } from 'hono';
import { error } from '../api/envelope.js';
import { errorContext, TELEMETRY_ERROR_CODES, TELEMETRY_ROUTES, type ApiErrorTelemetry } from './error-context.js';
export function apiErrorTelemetry(store: { recordApiError(event: ApiErrorTelemetry): Promise<void> }): MiddlewareHandler {
  return async (context, next) => errorContext.run({}, async () => {
    await next();
    if (context.res.status < 400) return;
    const candidate = errorContext.getStore()?.code;
    const code = TELEMETRY_ERROR_CODES.includes(candidate as typeof TELEMETRY_ERROR_CODES[number]) ? candidate! : 'UNCLASSIFIED_ERROR';
    const route = [...context.req.matchedRoutes].reverse().map(route => route.path).find(path => TELEMETRY_ROUTES.includes(path)) ?? 'unmatched';
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(context.req.method) ? context.req.method : 'OTHER';
    try { await store.recordApiError({ code, route, method, status: context.res.status }); }
    catch { context.res = context.json(error('UNAVAILABLE', 'Required error telemetry could not be persisted'), 503); }
  });
}
