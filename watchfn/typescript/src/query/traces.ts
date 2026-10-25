import { QueryValidationError } from './query-engine';
import type { QueryOptions, QueryFilter } from './types';

export interface TraceQueryOptions extends Pick<QueryOptions, 'timeRange' | 'limit' | 'orderBy'> {
  operation?: string; traceId?: string; service?: string; status?: 'error' | 'ok';
  duration?: number | { gt?: number; gte?: number; lt?: number; lte?: number; eq?: number; neq?: number };
}
export interface TraceDetailsOptions { traceId: string; includeSpans?: boolean; includeLogs?: boolean }
export interface ServiceMapOptions { timeRange?: QueryOptions['timeRange']; minCalls?: number }
export interface StoredTraceSpan {
  id: string; traceId: string; name: string; startTime: number; endTime: number; duration: number;
  parentId?: string; service?: string; tags?: Record<string, unknown>; logs?: unknown[];
}
export interface TraceDetails {
  traceId: string; startTime: number; endTime: number; duration: number; status: 'error' | 'ok';
  spans?: StoredTraceSpan[]; logs?: Record<string, unknown>[];
}
type Query = (options: QueryOptions) => Promise<any[]>;
const identifier = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new QueryValidationError(`Invalid ${name}`);
  return value;
};
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_TRACE_ROWS = 10000;
/** Queries canonical stored trace.span envelopes; no flush/self-join inside alert callbacks. */
export class TraceQueries {
  constructor(private readonly queryEvents: Query) {}
  async query(options: TraceQueryOptions): Promise<StoredTraceSpan[]> {
    if (!record(options)) throw new QueryValidationError('Trace options must be an object');
    const where: QueryFilter = { type: 'track' };
    for (const [key, field] of [['operation', 'name'], ['traceId', 'traceId'], ['service', 'service']] as const) {
      if (options[key] !== undefined) where[`properties.${field}`] = identifier(options[key], key);
    }
    if (options.status !== undefined) {
      if (!['error', 'ok'].includes(options.status)) throw new QueryValidationError('Invalid trace status');
      where['properties.tags.error'] = options.status === 'error' ? true : { neq: true };
    }
    if (options.duration !== undefined) {
      const filters: [string, unknown][] = record(options.duration) ? Object.entries(options.duration) : [['eq', options.duration]];
      if (!filters.length || filters.some(([key, value]) => !['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new QueryValidationError('Invalid trace duration');
      where['properties.duration'] = options.duration;
    }
    let orderBy: QueryOptions['orderBy'];
    if (options.orderBy !== undefined) {
      if (!record(options.orderBy) || !['duration', 'startTime', 'endTime', 'name', 'service', 'traceId'].includes(options.orderBy.field)) throw new QueryValidationError('Invalid trace order field');
      orderBy = { ...options.orderBy, field: `properties.${options.orderBy.field}` };
    }
    const events = await this.queryEvents({ metric: 'trace.span', where, timeRange: options.timeRange, limit: options.limit, orderBy });
    return events.map(event => {
      const span = event.properties;
      if (!record(span) || typeof span.id !== 'string' || typeof span.traceId !== 'string' || typeof span.name !== 'string' || !Number.isFinite(span.startTime) || !Number.isFinite(span.endTime) || !Number.isFinite(span.duration)) throw new QueryValidationError('Invalid stored trace span');
      if (span.parentId !== undefined) identifier(span.parentId, 'stored parentId');
      if (span.service !== undefined) identifier(span.service, 'stored service');
      if (span.tags !== undefined && !record(span.tags)) throw new QueryValidationError('Invalid stored span tags');
      if (span.logs !== undefined && !Array.isArray(span.logs)) throw new QueryValidationError('Invalid stored span logs');
      return structuredClone(span) as StoredTraceSpan;
    });
  }
  async getTrace(options: TraceDetailsOptions): Promise<TraceDetails | null> {
    if (!record(options)) throw new QueryValidationError('Trace details options must be an object');
    const traceId = identifier(options.traceId, 'traceId');
    for (const key of ['includeSpans', 'includeLogs'] as const) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new QueryValidationError(`Invalid ${key}`);
    const spans = await this.query({ traceId, limit: MAX_TRACE_ROWS + 1 });
    if (spans.length > MAX_TRACE_ROWS) throw new QueryValidationError('Trace detail capacity exceeded');
    if (!spans.length) return null;
    if (new Set(spans.map(span => span.id)).size !== spans.length) throw new QueryValidationError('Duplicate stored span identity');
    spans.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    const startTime = Math.min(...spans.map(span => span.startTime)), endTime = Math.max(...spans.map(span => span.endTime));
    const logs = options.includeLogs ? await this.queryEvents({ where: { type: 'log', traceId }, limit: MAX_TRACE_ROWS + 1 }) : undefined;
    if (logs && logs.length > MAX_TRACE_ROWS) throw new QueryValidationError('Trace log capacity exceeded');
    return { traceId, startTime, endTime, duration: endTime - startTime, status: spans.some(span => span.tags?.error === true) ? 'error' : 'ok',
      ...(options.includeSpans ? { spans } : {}), ...(logs ? { logs: structuredClone(logs) } : {}) };
  }
  async getServiceMap(options: ServiceMapOptions) {
    if (!record(options)) throw new QueryValidationError('Service map options must be an object');
    const minCalls = options.minCalls ?? 1;
    if (!Number.isSafeInteger(minCalls) || minCalls < 1) throw new QueryValidationError('minCalls must be a positive integer');
    const spans = await this.query({ timeRange: options.timeRange, limit: MAX_TRACE_ROWS + 1 });
    if (spans.length > MAX_TRACE_ROWS) throw new QueryValidationError('Service map capacity exceeded');
    const byId = new Map<string, StoredTraceSpan>();
    for (const span of spans) {
      const key = JSON.stringify([span.traceId, span.id]);
      if (byId.has(key)) throw new QueryValidationError('Duplicate stored span identity');
      byId.set(key, span);
    }
    const nodes = new Set<string>(), edges = new Map<string, { source: string; target: string; calls: number; errors: number; totalDuration: number }>();
    let unlinkedSpans = 0;
    for (const span of spans) {
      if (typeof span.service !== 'string' || !span.service) { unlinkedSpans++; continue; }
      nodes.add(span.service);
      if (!span.parentId) continue;
      const parent = byId.get(JSON.stringify([span.traceId, span.parentId]));
      if (!parent || typeof parent.service !== 'string' || !parent.service) { unlinkedSpans++; continue; }
      if (parent.service === span.service) continue;
      const key = JSON.stringify([parent.service, span.service]);
      const edge = edges.get(key) ?? { source: parent.service, target: span.service, calls: 0, errors: 0, totalDuration: 0 };
      edge.calls++; edge.errors += span.tags?.error === true ? 1 : 0; edge.totalDuration += span.duration; edges.set(key, edge);
    }
    return { nodes: [...nodes].sort().map(service => ({ service })), edges: [...edges.values()].filter(edge => edge.calls >= minCalls).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)).map(({ totalDuration, ...edge }) => ({ ...edge, averageDuration: totalDuration / edge.calls })), unlinkedSpans };
  }
}
