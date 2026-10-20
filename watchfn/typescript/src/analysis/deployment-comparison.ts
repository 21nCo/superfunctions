import { QueryValidationError } from '../query/query-engine';
import { TimeRangeParser } from '../query/time-range';
import type { QueryOptions } from '../query/types';

export interface DeploymentComparisonOptions {
  deploymentId: string;
  beforeWindow: string;
  afterWindow: string;
  requestMetric?: string;
  errorMetric?: string;
  durationField?: string;
}

export interface ComparedMetric {
  before: number | null;
  after: number | null;
  /** Relative percent increase; null when unavailable, incomplete or undefined. */
  increase: number | null;
  delta: number | null;
}

function timestamp(event: any): number {
  const value = event.timestamp === undefined ? event.ts : event.timestamp;
  if (value instanceof Date) return value.getTime();
  return typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
}
function field(event: any, path: string): unknown {
  const parts = path.split('.');
  let value = Object.prototype.hasOwnProperty.call(event, parts[0]) ? event : event.properties;
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
function comparison(before: number | null, after: number | null, complete: boolean): ComparedMetric {
  const delta = before === null || after === null ? null : after - before;
  const increase = !complete || delta === null ? null : before === 0 ? (after === 0 ? 0 : null) : delta / before! * 100;
  return { before, after, delta, increase: increase !== null && Number.isFinite(increase) ? increase : null };
}

/** Compare stored samples around one identified deployment, without invented baselines. */
export async function compareDeploymentMetrics(query: (options: QueryOptions) => Promise<any[]>, options: DeploymentComparisonOptions) {
  if (!options || typeof options !== 'object' || typeof options.deploymentId !== 'string' || !options.deploymentId.trim()) throw new QueryValidationError('deploymentId is required');
  let beforeMs: number, afterMs: number;
  try { beforeMs = TimeRangeParser.parseDuration(options.beforeWindow); afterMs = TimeRangeParser.parseDuration(options.afterWindow); }
  catch { throw new QueryValidationError('Deployment windows must be positive durations'); }
  const requestMetric = options.requestMetric ?? 'api.request';
  const errorMetric = options.errorMetric ?? 'api.error';
  const durationField = options.durationField ?? 'duration';
  if (![requestMetric, errorMetric, durationField].every(value => typeof value === 'string' && value.trim())) throw new QueryValidationError('Metric names and duration field must be nonempty strings');
  if (durationField.split('.').some(part => !part || ['__proto__','constructor','prototype'].includes(part))) throw new QueryValidationError('Invalid duration field');
  const deployments = await query({metric:'deployment.completed',where:{deploymentId:options.deploymentId}});
  const times = new Set(deployments.map(timestamp));
  if (!deployments.length || times.size !== 1 || !Number.isFinite([...times][0])) throw new QueryValidationError('Deployment timestamp is missing or ambiguous');
  const at = [...times][0];
  const from = at - beforeMs, to = at + afterMs;
  if (![from,at,to].every(Number.isSafeInteger)) throw new QueryValidationError('Deployment windows exceed safe timestamps');
  const observedAt = Date.now();
  const [requests, errors] = await Promise.all([
    query({metric:requestMetric,timeRange:{from,to}}),
    query({metric:errorMetric,timeRange:{from,to}}),
  ]);
  const within = (events: any[], start: number, end: number) => events.filter(event => { const time = timestamp(event); return time >= start && time < end; });
  const beforeRequests = within(requests,from,at), afterRequests = within(requests,at,to);
  const beforeErrors = within(errors,from,at), afterErrors = within(errors,at,to);
  const mean = (events: any[]) => {
    const values = events.map(event => field(event,durationField)).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const value = values.length ? values.reduce((sum,value)=>sum+value/values.length,0) : null;
    if (value !== null && !Number.isFinite(value)) throw new QueryValidationError('Latency mean exceeds finite numeric range');
    return {value,count:values.length};
  };
  const beforeLatency=mean(beforeRequests), afterLatency=mean(afterRequests);
  const complete = observedAt >= to;
  return {
    deploymentId: options.deploymentId,
    deployedAt: at,
    observedAt,
    windows: {before:{from,to:at},after:{from:at,to},complete},
    samples: {before:{requests:beforeRequests.length,errors:beforeErrors.length,latency:beforeLatency.count},after:{requests:afterRequests.length,errors:afterErrors.length,latency:afterLatency.count}},
    errorRate: comparison(beforeRequests.length ? beforeErrors.length/beforeRequests.length : null,afterRequests.length ? afterErrors.length/afterRequests.length : null,complete),
    latency: comparison(beforeLatency.value,afterLatency.value,complete),
  };
}
