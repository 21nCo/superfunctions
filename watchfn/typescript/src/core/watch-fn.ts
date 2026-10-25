import { createHash, timingSafeEqual } from "node:crypto";
import { isAuthSession } from "@superfunctions/auth";
import { compareDeploymentMetrics, DeploymentComparisonOptions } from "../analysis/deployment-comparison";
import { WatchFnConfig, WatchFnConfigSchema, WatchFnInstance } from "./types";
import { EventRouter } from "./event-router";
import { MemoryStorage } from "../storage/memory-storage";
import type { RetentionPageOptions, RetentionPageResult } from "../storage/event-retention";
import { DatabaseStorage } from "../storage/database";
import { StorageAdapter } from "../storage/types";
import { ExceptionHandler } from "../collectors/errors/exception-handler";
import { HttpInterceptor } from "../collectors/apm/http-interceptor";
import { Tracer } from "../trace/tracer";
import { AlertManager } from "../alerts/alert-manager";
import { TraceQueries, type TraceQueryOptions, type TraceDetailsOptions, type ServiceMapOptions } from '../query/traces';
import { QueryEngine } from "../query/query-engine";
import type { AggregateOptions } from "../query/types";
import { logQuery, logAggregate, type LogQueryOptions, type LogAggregateOptions } from "../query/logs";
import { SystemMetricsCollector } from "../collectors/infra/system-metrics";
import { ProcessMetricsCollector } from "../collectors/infra/process-metrics";
import { SyntheticScheduler } from "../synthetics/scheduler";
import { Router } from "@superfunctions/http";
import { createWatchFnRouter } from "../http/router";

import type { BugReportReference } from "../integrations/botfn/types";

interface StorageWrite {
  completion: Promise<void>;
  failed: boolean;
  error?: unknown;
}

export class WatchFn implements WatchFnInstance {
  private config: WatchFnConfig;
  private eventRouter: EventRouter;
  public httpRouter: Router;
  private storage: StorageAdapter | null = null;
  private exceptionHandler: ExceptionHandler;
  private httpInterceptor: HttpInterceptor;
  private tracer: Tracer;
  private alertManager?: AlertManager;
  private queryEngine: QueryEngine | null = null;
  private systemMetrics: SystemMetricsCollector;
  private processMetrics: ProcessMetricsCollector;
  private syntheticsScheduler: SyntheticScheduler;
  private isStarted: boolean = false;
  private pendingWrites = new Set<StorageWrite>();
  private failedWrites = new Set<StorageWrite>();
  private stopping?: Promise<void>;
  private readonly storageListener = (event: unknown): void => {
    const storage = this.storage;
    if (storage && this.isStarted) this.write(() => storage.add(event));
  };

  /** Observe every storage outcome immediately, including synchronous adapter throws. */
  private write(operation: () => void | Promise<void>): StorageWrite {
    let finish!: () => void;
    const record: StorageWrite = { failed: false, completion: new Promise<void>(resolve => { finish = resolve; }) };
    this.pendingWrites.add(record);
    const settle = (failed: boolean, error?: unknown) => {
      record.failed = failed;
      record.error = error;
      if (failed) this.failedWrites.add(record);
      this.pendingWrites.delete(record);
      finish();
    };
    try { Promise.resolve(operation()).then(() => settle(false), error => settle(true, error)); }
    catch (error) { settle(true, error); }
    return record;
  }

  private async drain(consumeFailures: boolean): Promise<void> {
    // Capture a barrier, so unrelated later writes cannot make a flush endless.
    const records = new Set([...this.failedWrites, ...this.pendingWrites]);
    await Promise.all([...records].map(record => record.completion));
    const failures = [...records].filter(record => record.failed);
    if (consumeFailures) for (const record of failures) this.failedWrites.delete(record);
    if (failures.length) throw new AggregateError(failures.map(record => record.error), "WatchFn storage operations failed");
  }

  /** Await writes admitted before this call, reporting and consuming retained failures. */
  flush(): Promise<void> {
    return this.drain(true);
  }

  /** True only while collectors route captured events into the configured runtime. */
  get started(): boolean {
    return this.isStarted;
  }

  constructor(config: WatchFnConfig) {
    this.config = WatchFnConfigSchema.parse(config);
    if (this.config.botfn && (this.config.storage !== "database" || !this.config.database || this.config.auth?.enabled === false || (!this.config.auth?.apiKey?.trim() && !this.config.auth?.provider))) {
      throw new TypeError("BotFn issue ingestion requires database storage and a configured API key");
    }
    if (this.config.retention && (this.config.storage !== "database" || !this.config.database)) throw new TypeError("Event retention requires shared database storage");
    if (this.config.auth?.provider && this.config.auth.enabled === false) throw new TypeError("Auth provider cannot be disabled");
    this.eventRouter = new EventRouter();
    this.exceptionHandler = new ExceptionHandler(this);
    this.httpInterceptor = new HttpInterceptor(this);
    this.tracer = new Tracer(this, this.config.name);
    this.systemMetrics = new SystemMetricsCollector(this, this.config.infra?.interval);
    this.processMetrics = new ProcessMetricsCollector(this, this.config.infra?.interval);
    this.syntheticsScheduler = new SyntheticScheduler(this);
    
    // Initialize HTTP Router
    this.httpRouter = createWatchFnRouter(this);
    
    // Storage initialization logic
    if (this.config.storage === "database" && this.config.database) {
        this.storage = new DatabaseStorage(this.config.database, "watchfn_events", this.config.botfn, this.config.retention);
        this.queryEngine = new QueryEngine(this.storage);
    } else if (this.config.storage === "memory") {
        this.storage = new MemoryStorage();
        this.queryEngine = new QueryEngine(this.storage);
    }
  }

  /** Await persistence for external batches; never acknowledge stopped storage. */
  async ingest(events: Record<string, unknown>[]): Promise<void> {
    if (!this.isStarted || !this.storage) throw new Error("WatchFn storage is unavailable");
    const storage = this.storage;
    const batch = [...events];
    // Validate every authorized route before admitting any member of the batch.
    if (storage instanceof DatabaseStorage && storage.bugIssues) {
      for (const event of batch) if (event.type === "bug_report") storage.bugIssues.validate(event);
    }
    const record = this.write(async () => {
      // A batch admitted before stop remains owned until its entire operation settles.
      for (const event of batch) await storage.add(event);
    });
    await record.completion;
    if (record.failed) throw record.error;
  }

  private requireBugIssues() {
    if (!(this.storage instanceof DatabaseStorage) || !this.storage.bugIssues) throw new Error("BotFn issue integration is unavailable");
    return this.storage.bugIssues;
  }

  /** Server-owned worker; awaiting stop also waits for admitted delivery work. */
  async processBugIssues(limit?: number): Promise<{ processed: number }> {
    if (!this.isStarted) throw new Error("WatchFn storage is unavailable");
    const issues = this.requireBugIssues();
    let result!: { processed: number };
    const record = this.write(async () => { result = await issues.process(limit); });
    await record.completion;
    if (record.failed) throw record.error;
    return result;
  }

  /** Privileged host scheduler only. No HTTP cleanup route is exposed. */
  async cleanupRetention(options: RetentionPageOptions = {}): Promise<RetentionPageResult> {
    if (!this.isStarted || !(this.storage instanceof DatabaseStorage)) throw new Error("WatchFn storage is unavailable");
    const storage = this.storage; const page = { ...options };
    let result!: RetentionPageResult;
    const record = this.write(async () => { result = await storage.cleanupRetention(page); });
    await record.completion;
    if (record.failed) throw record.error;
    return result;
  }

  getBugIssueStatus(ref: BugReportReference) { return this.requireBugIssues().status(ref); }

  /** Privileged operator method; the provider verifies destination and report marker. */
  async reconcileBugIssue(ref: BugReportReference, issueId: string): Promise<boolean> {
    if (!this.isStarted) throw new Error("WatchFn storage is unavailable");
    const issues = this.requireBugIssues();
    let result = false;
    const record = this.write(async () => { result = await issues.reconcile(ref, issueId); });
    await record.completion;
    if (record.failed) throw record.error;
    return result;
  }

  authorizeIngest(request: Request): boolean {
    const auth = this.config.auth;
    if (auth?.provider) return false; // Provider authentication is asynchronous; use authorizeHttp.
    if (auth?.enabled === false) return true;
    if (!auth?.apiKey) return false;
    // Fixed-size digests avoid length-dependent comparison errors and prefix comparisons.
    const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
    const bearer = timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${auth.apiKey}`));
    const apiKey = timingSafeEqual(digest(request.headers.get("x-api-key") ?? ""), digest(auth.apiKey));
    return bearer || apiKey;
  }

  /** Scope checks apply to HTTP only; programmatic methods remain trusted host APIs. */
  async authorizeHttp(request: Request, scope: "watchfn:ingest" | "watchfn:query" | "watchfn:issues:status"): Promise<401 | 403 | 503 | null> {
    const provider = this.config.auth?.provider;
    if (!provider) return this.authorizeIngest(request) ? null : 401;
    try {
      const session = await provider.authenticate(request);
      if (!isAuthSession(session)) return 401;
      if (session.expiresAt !== undefined && (!Number.isFinite(session.expiresAt.getTime()) || session.expiresAt.getTime() <= Date.now())) return 401;
      if (!session.scopes?.includes(scope)) return 403;
      return null;
    } catch { return 503; }
  }

  start() {
    if (this.stopping) throw new Error("WatchFn is stopping; await stop() before restarting");
    if (this.isStarted) return;
    this.isStarted = true;
    
    // Wire up storage
    if (this.storage) {
        this.eventRouter.on("event", this.storageListener);
    }

    if (this.config.errors?.enabled) {
      this.exceptionHandler.install(this.config.errors);
    }

    if (this.config.apm?.enabled) {
        if (this.config.apm.autoInstrument?.http) {
            this.httpInterceptor.install();
        }
    }
    
    if (this.config.infra?.enabled !== false) {
        if (this.config.infra?.system !== false) this.systemMetrics.start();
        if (this.config.infra?.process !== false) this.processMetrics.start();
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.isStarted = false;
    this.eventRouter.removeListener("event", this.storageListener);
    // Continue cleanup even if one collector fails; surface every failure with storage.
    for (const cleanup of [
      () => this.exceptionHandler.uninstall(),
      () => this.httpInterceptor.uninstall(),
      () => this.systemMetrics.stop(),
      () => this.processMetrics.stop(),
      () => this.syntheticsScheduler.stop(),
    ]) {
      try { cleanup(); } catch (error) { this.write(() => { throw error; }); }
    }
    const stopped = this.drain(false);
    this.stopping = stopped;
    // Observe ignored legacy stop() calls while keeping rejection visible to awaiters.
    const complete = () => { if (this.stopping === stopped) this.stopping = undefined; };
    void stopped.then(complete, complete);
    return stopped;
  }

  track(eventName: string, properties?: Record<string, any>) {
    if (!this.isStarted) return;
    this.eventRouter.ingest({
      type: "track",
      name: eventName,
      properties,
      timestamp: new Date(),
    });
  }

  captureException(error: any, context?: Record<string, any>) {
    if (!this.isStarted) return;
    this.eventRouter.ingest({
      type: "error",
      error,
      context,
      timestamp: new Date(),
    });
  }

  captureMessage(message: string, context?: Record<string, any>) {
    if (!this.isStarted) return;
    this.eventRouter.ingest({
      type: "message",
      message,
      context,
      timestamp: new Date(),
    });
  }
  
  async query(params: any): Promise<any> {
      if (this.queryEngine) {
          const result = await this.queryEngine.execute(params);
          return result.data;
      }
      throw new Error("WatchFn storage is unavailable");
  }
  
  async aggregate(params: AggregateOptions): Promise<any[]> {
      if (!this.queryEngine) throw new Error("WatchFn storage is unavailable");
      return (await this.queryEngine.aggregate(params)).data;
  }
  
  async compareDeploymentMetrics(params: DeploymentComparisonOptions) {
      return compareDeploymentMetrics(options => this.query(options), params);
  }
  
  // Accessors for sub-modules could go here
  get infra() {
      return {
          monitor: (opts: any) => {}, // Dynamic reconfig stub
          monitorProcess: (opts: any) => {}, 
          getProcessMetrics: async (opts: any) => [], // Stub for query helper
          getHealth: async (opts: any) => ({}),
          getResourceUsage: async (opts: any) => ({}),
      }
  }

  get trace() {
    return {
        start: (name: string, cb: Function, opts?: any) => this.tracer.start(name, cb as any, opts),
        startSpan: (name: string, opts?: any) => this.tracer.startSpan(name, opts),
        query: (opts: TraceQueryOptions) => new TraceQueries(options => this.query(options)).query(opts),
        getTrace: (opts: TraceDetailsOptions) => new TraceQueries(options => this.query(options)).getTrace(opts),
        getServiceMap: (opts: ServiceMapOptions) => new TraceQueries(options => this.query(options)).getServiceMap(opts),
    }
  }
  
  get logs() {
      return {
          query: async (opts: LogQueryOptions) => this.query(logQuery(opts)),
          aggregate: async (opts: LogAggregateOptions) => this.aggregate(logAggregate(opts)),
          createPattern: async (opts: any) => {},
          detectPatterns: async (opts: any) => [],
      }
  }
  
  get business() {
      return {
          track: (event: string, props: any) => this.track(event, props),
          createGoal: async (opts: any) => {},
          getGoalProgress: async (opts: any) => ({}),
          createFunnel: async (opts: any) => ({}),
          getFunnel: async (opts: any) => ({}),
          getDropoffAnalysis: async (opts: any) => ({}),
          getRevenue: async (opts: any) => ({}),
          getMRR: async (opts: any) => ({}),
          getChurnRate: async (opts: any) => ({}),
          getLTV: async (opts: any) => ({}),
      }
  }
  
  get alerts() {
    if (!this.alertManager) {
      if (this.config.storage !== 'memory' && (this.config.storage !== 'database' || !this.config.database)) throw new Error('Alert storage is unavailable; configure memory or a shared database adapter');
      const database = this.config.storage === 'database' ? this.config.database : undefined;
      if (database && !('create' in database)) throw new TypeError('Durable alerts require a shared DB Adapter');
      this.alertManager = new AlertManager({
        name: this.config.name, config: this.config.alerts, database: database as import('@superfunctions/db').Adapter | undefined,
        observations: (metric, from, now, maximum) => {
          if (!this.queryEngine) throw new Error('WatchFn storage is unavailable');
          return this.queryEngine.alertObservations(metric, from, now, maximum);
        },
        admit: async <T>(operation: () => Promise<T>, started = false): Promise<T> => {
          if (this.stopping || (started && !this.isStarted)) throw new Error('WatchFn storage is unavailable');
          let result!: T;
          const record = this.write(async () => { result = await operation(); });
          await record.completion;
          if (record.failed) throw record.error;
          return result;
        },
      });
    }
    return this.alertManager;
  }
  

  get synthetics() {
      return {
          create: async (opts: any) => this.syntheticsScheduler.create(opts),
          getUptime: async (opts: any) => ({}),
          getIncidents: async (opts: any) => [],
          getPerformanceTrend: async (opts: any) => ({}),
      }
  }
  
  get dashboard() {
      return {
          create: async (opts: any) => {},
          share: async (id: string, opts: any) => "",
          export: async (id: string, opts: any) => {},
          snapshot: async (id: string, opts: any) => {},
      }
  }
  
  get rum() {
      return {
          getWebVitals: async (opts: any) => ({}),
          getPageLoads: async (opts: any) => ({}),
          getUserJourney: async (opts: any) => ({}),
      }
  }
  
  get errors() {
      return {
          query: async (opts: any) => [],
          markResolved: async (id: string, opts: any) => {},
          getTrend: async (opts: any) => ({}),
          addBreadcrumb: (crumb: any) => this.exceptionHandler.addBreadcrumb(crumb),
          getBreadcrumbs: () => this.exceptionHandler.getBreadcrumbs(),
      }
  }
  
  // Integration helpers
  use(integration: any, options?: any) {
      // Logic to attach integration
  }
  
  // Transaction helper
  startTransaction(name: string) {
      return this.tracer.startTransaction(name);
  }
}

export function watchFn(config: WatchFnConfig): WatchFn {
  return new WatchFn(config);
}
