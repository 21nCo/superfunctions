/**
 * Main CatchFn SDK class
 */

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

  constructor(config: CatchFnConfig) {
    this.config = {
      ...config,
      maxBreadcrumbs: config.maxBreadcrumbs ?? 50,
      maxConsoleLogs: config.maxConsoleLogs ?? 100,
      maxNetworkRequests: config.maxNetworkRequests ?? 20,
      defaultSeverity: config.defaultSeverity ?? "medium",
      ignorePatterns: config.ignorePatterns ?? [],
      maxPayloadSize: config.maxPayloadSize ?? 262144, // 256KB
      sensitiveFields: config.sensitiveFields ?? [],
      enableBreadcrumbs: config.enableBreadcrumbs ?? true,
      enableConsoleCapture: config.enableConsoleCapture ?? false,
      enableNetworkCapture: config.enableNetworkCapture ?? false,
    };

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
        this.config.maxNetworkRequests
      );
      this.networkCollector.start();
    }

    // Register hooks
    if (this.config.beforeSend) {
      this.beforeSendHooks.push(this.config.beforeSend);
    }

    // Register ignore patterns
    this.ignorePatterns = [...this.config.ignorePatterns];
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

      try {
        current = await hook(current);
      } catch (error) {
        console.error("CatchFn: beforeSend hook failed:", error);
        // Continue with original event
      }
    }

    return current;
  }

  /**
   * Capture a bug report
   */
  async captureBug(options: CaptureBugOptions): Promise<BugReportEvent> {
    // Construct the event
    let event: BugReportEvent = {
      id: generateId(),
      timestamp: Date.now(),
      title: options.title,
      description: options.description,
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

    if (this.consoleCollector) {
      event.consoleLogs = this.consoleCollector.collect();
    }

    if (this.networkCollector) {
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

    // Apply size limits
    event = limitPayloadSize(event, this.config.maxPayloadSize);

    // Check ignore patterns
    if (this.shouldIgnore(event)) {
      console.log("CatchFn: Event ignored by ignore patterns");
      // Return the event anyway for transparency
      return event;
    }

    // Apply beforeSend hooks
    const processedEvent = await this.applyHooks(event);

    if (!processedEvent) {
      console.log("CatchFn: Event dropped by beforeSend hook");
      // Return original event for transparency
      return event;
    }

    // TODO: Send to watchfn backend
    // For now, just log it
    console.log("CatchFn: Bug captured", {
      id: processedEvent.id,
      title: processedEvent.title,
      severity: processedEvent.severity,
    });

    return processedEvent;
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
  stop(): void {
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
