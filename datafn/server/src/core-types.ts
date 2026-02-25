/**
 * Server-local types compatible with @datafn/core.
 * Defined here to avoid TS2709 ("Cannot use namespace as a type") when
 * emitting declarations that reference types from @datafn/core.
 * These shapes must stay compatible with the core package.
 */
export type DatafnSchema = {
  resources: Array<{
    name: string;
    version: number;
    idPrefix?: string;
    isRemoteOnly?: boolean;
    fields: unknown[];
    indices?: unknown;
    permissions?: unknown;
  }>;
  relations?: unknown[];
};

export interface RetentionConfig {
  /** Number of days to retain change log entries. Default: unlimited. */
  changeLogDays?: number;
  /** Number of days to retain idempotency records. Default: unlimited. */
  idempotencyDays?: number;
  /** Whether to run pruning on server startup. Default: false. */
  pruneOnStartup?: boolean;
  /** Interval in milliseconds for periodic pruning. Minimum: 60000. Default: disabled. */
  pruneIntervalMs?: number;
}

export interface RateLimitConfig<TContext = any> {
  /** Enable rate limiting. Default: false. */
  enabled: boolean;
  /** Max requests per window per client. Default: 100. */
  maxRequests?: number;
  /** Window duration in seconds. Default: 60. */
  windowSeconds?: number;
  /** Per-endpoint overrides */
  endpoints?: Partial<Record<
    'query' | 'mutation' | 'transact' | 'push' | 'pull' | 'clone' | 'reconcile' | 'seed',
    { maxRequests: number; windowSeconds: number }
  >>;
  /** Key extractor for identifying clients. Default: uses authContext userId or "anonymous". */
  keyExtractor?: (ctx: TContext) => string | Promise<string>;
}

export interface ObservabilityConfig {
  /** Emit execution timing events. Default: false. */
  timing?: boolean;
  /** Custom timing event handler. Default: console.debug. */
  onTiming?: (event: import("./middleware/timing.js").ExecutionTimingEvent) => void;
}

export type DatafnPlugin = {
  name: string;
  runsOn: Array<"client" | "server">;
  beforeQuery?: (ctx: unknown, q: unknown) => Promise<unknown> | unknown;
  afterQuery?: (ctx: unknown, q: unknown, result: unknown) => Promise<unknown> | unknown;
  beforeMutation?: (ctx: unknown, m: unknown) => Promise<unknown> | unknown;
  afterMutation?: (ctx: unknown, m: unknown, result: unknown) => Promise<void> | void;
  beforeSync?: (ctx: unknown, phase: string, payload: unknown) => Promise<unknown> | unknown;
  afterSync?: (ctx: unknown, phase: string, payload: unknown, result: unknown) => Promise<void> | void;
};
