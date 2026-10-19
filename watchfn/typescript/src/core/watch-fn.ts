import { WatchFnConfig, WatchFnConfigSchema, WatchFnInstance } from "./types";
import { EventRouter } from "./event-router";
import { MemoryStorage } from "../storage/memory-storage";
import { DatabaseStorage } from "../storage/database";
import { StorageAdapter } from "../storage/types";
import { ExceptionHandler } from "../collectors/errors/exception-handler";
import { HttpInterceptor } from "../collectors/apm/http-interceptor";
import { Tracer } from "../trace/tracer";
import { AlertManager } from "../alerts/alert-manager";
import { QueryEngine } from "../query/query-engine";
import type { AggregateOptions } from "../query/types";
import { SystemMetricsCollector } from "../collectors/infra/system-metrics";
import { ProcessMetricsCollector } from "../collectors/infra/process-metrics";
import { SyntheticScheduler } from "../synthetics/scheduler";
import { Router } from "@superfunctions/http";
import { createWatchFnRouter } from "../http/router";

export class WatchFn implements WatchFnInstance {
  private config: WatchFnConfig;
  private eventRouter: EventRouter;
  public httpRouter: Router;
  private storage: StorageAdapter | null = null;
  private exceptionHandler: ExceptionHandler;
  private httpInterceptor: HttpInterceptor;
  private tracer: Tracer;
  private alertManager: AlertManager;
  private queryEngine: QueryEngine | null = null;
  private systemMetrics: SystemMetricsCollector;
  private processMetrics: ProcessMetricsCollector;
  private syntheticsScheduler: SyntheticScheduler;
  private isStarted: boolean = false;

  /** True only while collectors route captured events into the configured runtime. */
  get started(): boolean {
    return this.isStarted;
  }

  constructor(config: WatchFnConfig) {
    this.config = WatchFnConfigSchema.parse(config);
    this.eventRouter = new EventRouter();
    this.exceptionHandler = new ExceptionHandler(this);
    this.httpInterceptor = new HttpInterceptor(this);
    this.tracer = new Tracer(this);
    this.alertManager = new AlertManager(this);
    this.systemMetrics = new SystemMetricsCollector(this, this.config.infra?.interval);
    this.processMetrics = new ProcessMetricsCollector(this, this.config.infra?.interval);
    this.syntheticsScheduler = new SyntheticScheduler(this);
    
    // Initialize HTTP Router
    this.httpRouter = createWatchFnRouter(this);
    
    // Storage initialization logic
    if (this.config.storage === "database" && this.config.database) {
        this.storage = new DatabaseStorage(this.config.database);
        this.queryEngine = new QueryEngine(this.storage);
    } else if (this.config.storage === "memory") {
        this.storage = new MemoryStorage();
        this.queryEngine = new QueryEngine(this.storage);
    }
  }

  /** Await persistence for external batches; never acknowledge stopped storage. */
  async ingest(events: Record<string, unknown>[]): Promise<void> {
    if (!this.isStarted || !this.storage) throw new Error("WatchFn storage is unavailable");
    for (const event of events) await this.storage.add(event);
  }

  authorizeIngest(request: Request): boolean {
    const auth = this.config.auth;
    if (auth?.enabled === false) return true;
    if (!auth?.enabled && !auth?.apiKey) return true;
    if (!auth.apiKey) return false;
    return request.headers.get("authorization") === `Bearer ${auth.apiKey}` || request.headers.get("x-api-key") === auth.apiKey;
  }

  start() {
    if (this.isStarted) return;
    this.isStarted = true;
    
    // Wire up storage
    if (this.storage) {
        this.eventRouter.on("event", (event) => {
            this.storage?.add(event);
        });
    }

    if (this.config.errors?.enabled) {
      this.exceptionHandler.install();
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

  stop() {
    this.isStarted = false;
    this.eventRouter.removeAllListeners("event");
    this.httpInterceptor.uninstall();
    this.systemMetrics.stop();
    this.processMetrics.stop();
    this.syntheticsScheduler.stop();
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
  
  async compareDeploymentMetrics(params: any): Promise<any> {
      return {
          errorRate: { increase: 0 },
          latency: { increase: 0 }
      };
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
        query: async (opts: any) => [], // Stub for query
        getTrace: async (opts: any) => ({}), // Stub
        getServiceMap: async (opts: any) => ({}), // Stub
    }
  }
  
  get logs() {
      return {
          query: async (opts: any) => [],
          aggregate: async (opts: any) => ({}),
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
      return {
          create: async (opts: any) => this.alertManager.create(opts),
          list: async (filter?: { status?: string }) => this.alertManager.list(filter),
          onTrigger: (cb: any) => this.alertManager.onTrigger(cb),
          onResolve: (cb: any) => this.alertManager.onResolve(cb),
          addNote: async (id: string, note: any) => this.alertManager.addNote(id, note),
          acknowledge: async (id: string, data: any) => this.alertManager.acknowledge(id, data),
          resolve: async (id: string, data: any) => this.alertManager.resolve(id, data),
          trigger: async (id: string, data: any) => this.alertManager.trigger(id, data),
      }
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
      return {
          startSpan: (spanName: string) => ({
              finish: () => {}
          }),
          finish: () => {}
      }
  }
}

export function watchFn(config: WatchFnConfig): WatchFn {
  return new WatchFn(config);
}
