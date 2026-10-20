/**
 * Main CatchFn SDK class
 */

import { BrowserClient } from "@watchfn/browser";
import type { ReporterWidget } from "../reporter/widget.js";
import { BreadcrumbCollector } from "../collectors/breadcrumbs.js";
import { ConsoleCollector } from "../collectors/console.js";
import { NetworkCollector } from "../collectors/network.js";
import { DeviceCollector } from "../collectors/device.js";
import { redactObject } from "../utils/redaction.js";
import { safeSerialize } from "../utils/serialization.js";
import { limitPayloadSize } from "../utils/size-limiter.js";
import type {
  CatchFnConfig,
  BugReportEvent,
  CaptureBugOptions,
  BeforeSendHook,
  IgnorePattern,
  Breadcrumb,
  BugSeverity,
  WatchBugReportEvent,
  WatchBugReportClient,
} from "./types.js";

function generateId(): string {
  return `bug_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export class CatchFn {
  private config: CatchFnConfig & {
    maxBreadcrumbs: number;
    maxConsoleLogs: number;
    maxNetworkRequests: number;
    defaultSeverity: BugSeverity;
    maxPayloadSize: number;
    sensitiveFields: string[];
    ignorePatterns: IgnorePattern[];
  };
  private breadcrumbCollector: BreadcrumbCollector;
  private consoleCollector?: ConsoleCollector;
  private networkCollector?: NetworkCollector;
  private beforeSendHooks: BeforeSendHook[] = [];
  private ignorePatterns: IgnorePattern[] = [];
  private sessionId: string;
  private watchClient?: WatchBugReportClient;
  private reporter?: ReporterWidget;
  private opening?: Promise<void>;
  private reporterGeneration = 0;
  private reporterButton?: HTMLButtonElement;
  private hotkeyHandler?: (event: KeyboardEvent) => void;

  constructor(config: CatchFnConfig) {
    if (!config.name?.trim()) throw new TypeError("Application name is required");
    for (const value of [config.maxBreadcrumbs, config.maxConsoleLogs, config.maxNetworkRequests]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new RangeError("Collector limits must be nonnegative integers");
    }
    if (config.maxPayloadSize !== undefined && (!Number.isInteger(config.maxPayloadSize) || config.maxPayloadSize <= 0)) throw new RangeError("maxPayloadSize must be positive");
    const endpointWatch = config.watch && !("client" in config.watch) ? config.watch : undefined;
    if (endpointWatch && config.maxPayloadSize !== undefined && config.maxPayloadSize > 65536) {
      throw new RangeError("WatchFn ingestion permits at most 64 KiB per event");
    }
    if (endpointWatch) {
      const client = new BrowserClient({ ...endpointWatch, projectId: endpointWatch.projectId ?? config.name, autoTrack: false, sampleRate: 1 });
      this.watchClient = { capture: event => client.capture({ ...event }), flush: () => client.flush() };
    } else if (config.watch && "client" in config.watch) {
      this.watchClient = config.watch.client;
    }
    this.config = {
      ...config,
      maxBreadcrumbs: config.maxBreadcrumbs ?? 50,
      maxConsoleLogs: config.maxConsoleLogs ?? 100,
      maxNetworkRequests: config.maxNetworkRequests ?? 20,
      defaultSeverity: config.defaultSeverity ?? "medium",
      ignorePatterns: config.ignorePatterns ?? [],
      maxPayloadSize: config.maxPayloadSize ?? (endpointWatch ? 65536 : 262144),
      sensitiveFields: config.sensitiveFields ?? [],
      enableBreadcrumbs: config.enableBreadcrumbs ?? true,
      enableConsoleCapture: config.enableConsoleCapture ?? false,
      enableNetworkCapture: config.enableNetworkCapture ?? false,
    };

    this.sessionId = config.sessionId ?? generateId().replace("bug_", "session_");
    // Initialize collectors
    this.breadcrumbCollector = new BreadcrumbCollector(
      this.config.maxBreadcrumbs
    );

    if (this.config.enableConsoleCapture) {
      this.consoleCollector = new ConsoleCollector(this.config.maxConsoleLogs);
      this.consoleCollector.start();
    }

    if (this.config.enableNetworkCapture) {
      this.networkCollector = new NetworkCollector(
        this.config.maxNetworkRequests, this.config.network
      );
      this.networkCollector.start();
    }

    // Register hooks
    if (this.config.beforeSend) {
      this.beforeSendHooks.push(this.config.beforeSend);
    }

    // Register ignore patterns
    this.ignorePatterns = [...this.config.ignorePatterns];
    if (typeof document !== "undefined" && config.reporter?.floatingButton) {
      this.reporterButton = document.createElement("button");
      this.reporterButton.type = "button";
      this.reporterButton.textContent = "Report a bug";
      this.reporterButton.setAttribute("data-catchfn-ignore", "");
      this.reporterButton.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483646;padding:10px 16px";
      this.reporterButton.onclick = () => { this.reporterButton?.focus(); void this.openReporter().catch(() => console.error("Could not open bug reporter")); };
      document.body.append(this.reporterButton);
    }
    if (typeof document !== "undefined" && config.reporter?.hotkey) {
      const parts = config.reporter.hotkey.toLowerCase().split("+");
      const key = parts[parts.length - 1];
      this.hotkeyHandler = (event) => {
        if (event.key.toLowerCase() === key && event.altKey === parts.includes("alt") && event.ctrlKey === parts.includes("ctrl") && event.shiftKey === parts.includes("shift") && event.metaKey === parts.includes("meta")) {
          event.preventDefault();
          void this.openReporter().catch(() => console.error("Could not open bug reporter"));
        }
      };
      document.addEventListener("keydown", this.hotkeyHandler);
    }
  }

  /**
   * Add a breadcrumb
   */
  addBreadcrumb(breadcrumb: Omit<Breadcrumb, "timestamp">): void {
    if (!this.config.enableBreadcrumbs) return;
    this.breadcrumbCollector.add(breadcrumb);
  }

  /**
   * Register a beforeSend hook
   */
  beforeSend(hook: BeforeSendHook): void {
    this.beforeSendHooks.push(hook);
  }

  /**
   * Add an ignore pattern
   */
  addIgnorePattern(pattern: IgnorePattern): void {
    this.ignorePatterns.push(pattern);
  }

  /**
   * Check if an event should be ignored
   */
  private shouldIgnore(event: BugReportEvent): boolean {
    const message = event.title + " " + (event.description || "");

    return this.ignorePatterns.some((pattern) => {
      if (typeof pattern === "string") {
        return message.includes(pattern);
      }
      pattern.lastIndex = 0;
      return pattern.test(message);
    });
  }

  /**
   * Apply beforeSend hooks
   */
  private async applyHooks(
    event: BugReportEvent
  ): Promise<BugReportEvent | null> {
    let current: BugReportEvent | null = event;

    for (const hook of this.beforeSendHooks) {
      if (!current) break;

      current = await hook(current);
    }

    return current;
  }

  /**
   * Capture a bug report
   */
  async captureBug(options: CaptureBugOptions): Promise<BugReportEvent> {
    if (!options.title?.trim()) throw new TypeError("Bug title is required");
    if (options.severity !== undefined && !["critical", "high", "medium", "low"].includes(options.severity)) throw new TypeError("Invalid severity");
    // Construct the event
    let event: BugReportEvent = {
      id: generateId(),
      timestamp: Date.now(),
      title: options.title,
      description: options.description,
      steps: options.steps,
      severity: options.severity || this.config.defaultSeverity,
      tags: options.tags,
      environment: options.environment || this.config.environment,
      release: options.release || this.config.release,
      user: options.user || this.config.user,
      metadata: options.metadata,
      attachments: options.attachments,
    };

    // Collect context
    if (this.config.enableBreadcrumbs) {
      event.breadcrumbs = this.breadcrumbCollector.collect();
    }

    if (this.consoleCollector && options.includeConsoleLogs !== false) {
      event.consoleLogs = this.consoleCollector.collect();
    }

    if (this.networkCollector && options.includeNetworkLogs !== false) {
      event.networkRequests = this.networkCollector.collect();
    }

    // Collect device info
    event.deviceInfo = DeviceCollector.collect();

    // Redact sensitive data
    event = redactObject(
      event,
      this.config.sensitiveFields.map((f) => new RegExp(f, "i"))
    );

    // Serialize to ensure JSON-safe
    event = safeSerialize(event);

    // Check ignore patterns
    if (this.shouldIgnore(event)) {
      console.log("CatchFn: Event ignored by ignore patterns");
      // Return the event anyway for transparency
      return {...event, delivery:"dropped"};
    }

    // Apply beforeSend hooks
    let processedEvent = await this.applyHooks(event);

    if (!processedEvent) {
      console.log("CatchFn: Event dropped by beforeSend hook");
      // Return original event for transparency
      return {...event, delivery:"dropped"};
    }

    if (!processedEvent.title?.trim() || !["critical", "high", "medium", "low"].includes(processedEvent.severity)) throw new TypeError("beforeSend returned an invalid bug report");
    if (processedEvent.attachments) {
      processedEvent = { ...processedEvent, attachments: await Promise.all(processedEvent.attachments.map(async (attachment) => {
        let next = { ...attachment };
        if (next.dataUrl) {
          const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(next.dataUrl);
          if (!match) throw new TypeError("Invalid attachment data URL");
          const text = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
          const bytes = match[2] ? Uint8Array.from(text, character => character.charCodeAt(0)) : new TextEncoder().encode(text);
          const blob = new Blob([bytes], {type:match[1] ?? next.type});
          next.size = blob.size;
          if (blob.size > (this.config.reporter?.maxInlineBytes ?? 65536)) {
            if (!this.config.uploadAttachment) throw new RangeError("Attachment exceeds inline size limit; configure uploadAttachment");
            const uploaded = await this.config.uploadAttachment(blob, next);
            next = {...next, url:uploaded.url};
            delete next.dataUrl;
          }
        }
        if (next.url) {
          const url = new URL(next.url);
          if (!["https:","http:"].includes(url.protocol) || url.username || url.password) throw new TypeError("Attachment URL must use HTTP(S) without credentials");
        }
        return next;
      })) };
    }

    // Hooks can add context: apply privacy and byte limits to the final outgoing value.
    processedEvent = limitPayloadSize(redactObject(safeSerialize(processedEvent), this.config.sensitiveFields.map((field) => new RegExp(field, "i"))), this.config.maxPayloadSize);
    if (!processedEvent?.title?.trim() || !["critical", "high", "medium", "low"].includes(processedEvent.severity)) throw new TypeError("beforeSend returned an invalid bug report");
    if (this.shouldIgnore(processedEvent)) return {...processedEvent, delivery:"dropped"};

    if (this.watchClient) {
      const envelope = this.toWatchEvent(processedEvent);
      if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > this.config.maxPayloadSize) throw new RangeError("Bug report envelope exceeds maxPayloadSize");
      const result = await this.watchClient.capture(envelope);
      if (result?.integration) processedEvent = {...processedEvent, integration:result.integration};
    }

    return {...processedEvent, delivery:this.watchClient ? "sent" : "local"};
  }

  /**
   * Clear all collected context
   */
  clear(): void {
    this.breadcrumbCollector.clear();
    this.consoleCollector?.clear();
    this.networkCollector?.clear();
  }

  /**
   * Stop all collectors
   */
  hasTransport(): boolean { return Boolean(this.watchClient); }

  async flush(): Promise<void> { await this.watchClient?.flush?.(); }

  private toWatchEvent(report: BugReportEvent): WatchBugReportEvent {
    const context: Record<string, unknown> = {
      url: typeof location === "undefined" ? "" : location.href,
      locale: typeof navigator === "undefined" ? undefined : navigator.language,
      env: report.environment ?? this.config.env,
      release: report.release,
      featureFlags: this.config.featureFlags,
      viewport: typeof window === "undefined" ? undefined : {width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio},
      device: report.deviceInfo,
      console: report.consoleLogs?.map(log=>({level:log.level,message:JSON.stringify(log.args),ts:log.timestamp})),
      networkLogs: report.networkRequests?.map(request=>({...request,durationMs:request.duration})),
      breadcrumbs: report.breadcrumbs,
      custom: report.metadata,
    };
    return redactObject({id:report.id,type:"bug_report",timestamp:new Date(report.timestamp).toISOString(),app:{name:this.config.name,version:this.config.appVersion},user:report.user,sessionId:this.sessionId,context,report:{title:report.title,description:report.description,steps:report.steps,severity:report.severity,tags:report.tags},attachments:report.attachments,integration:report.integration});
  }

  async openReporter(): Promise<void> {
    if (typeof document === "undefined") throw new Error("Reporter requires a browser document");
    if (this.reporter?.isOpen) { this.reporter.focus(); return; }
    if (this.opening) return this.opening;
    const generation = this.reporterGeneration;
    this.opening = (async () => {
      const { ReporterWidget } = await import("../reporter/widget.js");
      if (generation !== this.reporterGeneration) return;
      this.reporter = new ReporterWidget(this, this.config.reporter);
      await this.reporter.open();
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  closeReporter(): void {
    this.reporterGeneration++;
    this.reporter?.close();
    this.reporter = undefined;
  }

  stop(): void {
    this.closeReporter();
    this.reporterButton?.remove();
    this.reporterButton = undefined;
    if (this.hotkeyHandler && typeof document !== "undefined") document.removeEventListener("keydown", this.hotkeyHandler);
    this.hotkeyHandler = undefined;
    this.consoleCollector?.stop();
    this.networkCollector?.stop();
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<typeof this.config> {
    return { ...this.config };
  }
}
