import { QueryValidationError } from './query-engine';
import type { AggregateOptions, QueryFilter, QueryOptions } from './types';

export interface LogQueryOptions extends Pick<QueryOptions, 'timeRange' | 'orderBy' | 'limit'> {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'warning' | 'error' | 'fatal';
  search?: string;
  filters?: QueryFilter;
}
export interface LogAggregateOptions extends LogQueryOptions {
  groupBy?: AggregateOptions['groupBy'];
  aggregation: Exclude<AggregateOptions['aggregation'], 'rate'>;
  field?: string;
  percentile?: number;
}
/** Canonical stored log events use type=log; generic query validation owns filters/ranges. */
export function logQuery(options: LogQueryOptions): QueryOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new QueryValidationError('Log options must be an object');
  if (options.filters !== undefined && (!options.filters || typeof options.filters !== 'object' || Array.isArray(options.filters))) throw new QueryValidationError('Log filters must be an object');
  const where: QueryFilter = { ...options.filters };
  if (Object.hasOwn(where, 'type')) throw new QueryValidationError('Log type is fixed; filters cannot override it');
  where.type = 'log';
  if (options.level !== undefined) {
    if (!['trace', 'debug', 'info', 'warn', 'warning', 'error', 'fatal'].includes(options.level)) throw new QueryValidationError('Invalid log level');
    if (Object.hasOwn(where, 'level')) throw new QueryValidationError('Specify log level once');
    where.level = options.level;
  }
  if (options.search !== undefined) {
    if (typeof options.search !== 'string' || options.search.length > 4096) throw new QueryValidationError('Log search must be a string of at most 4096 characters');
    if (Object.hasOwn(where, 'message')) throw new QueryValidationError('Specify message search once');
    where.message = { contains: options.search };
  }
  return { where, timeRange: options.timeRange, orderBy: options.orderBy, limit: options.limit };
}
export function logAggregate(options: LogAggregateOptions): AggregateOptions {
  return { ...logQuery(options), groupBy: options.groupBy, aggregation: options.aggregation, field: options.field, percentile: options.percentile };
}
