import type { Middleware } from '@superfunctions/http';
import type { Logger } from '../core/logger.js';
import {
  captureRequestBody, createRequestSampler, extractCorrelationIds,
  getDefaultRequestLogger, redactHeaders, type RequestLoggerOptions,
} from './middleware.js';

/** Request-scoped fields added to the shared HTTP context. */
export interface LogRequestContext { log?: Logger }

/** Structured request logs for any consumer of the shared HTTP router. */
export function requestLogger<TContext extends LogRequestContext = LogRequestContext>(
  options: RequestLoggerOptions = {},
): Middleware<TContext> {
  const root = options.logger ?? getDefaultRequestLogger();
  const sample = createRequestSampler(options.sample);
  const timeout = options.bodyCaptureTimeoutMs ?? 100;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('Body capture timeout must be a positive finite number');
  return async (request, context, next) => {
    const started = Date.now();
    const sampled = sample();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    const ids = extractCorrelationIds(headers, options.header);
    const identity = options.captureUser?.(request);
    const logger = root.child({ correlation: { ...ids, ...identity }, ctx: ids });
    context.log = logger;
    const metadata = { method: request.method, url: request.url, path: context.url.pathname };
    if (sampled) logger.info('Request started', {
      ...metadata, headers: redactHeaders(headers, options.redactHeaders),
      body: options.includeBody ? await captureRequestBody(request, timeout) : undefined,
    });
    try {
      const response = await next();
      if (sampled) logger.info('Request completed', {
        ...metadata, statusCode: response.status,
        contentLength: response.headers.get('content-length'), latencyMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      if (sampled) logger.info('Request failed', { ...metadata, statusCode: 500, latencyMs: Date.now() - started });
      throw error;
    }
  };
}

export type { RequestLoggerOptions } from './middleware.js';
