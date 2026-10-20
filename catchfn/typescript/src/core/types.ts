import type { BrowserConfig, BugIssueReference, BrowserBugIssueStatus } from "@watchfn/browser";

/**
 * Core types and interfaces for CatchFn
 */

/**
 * Bug severity levels
 */
export type BugSeverity = "low" | "medium" | "high" | "critical";

/**
 * Breadcrumb types
 */
export type BreadcrumbType =
  | "navigation"
  | "console"
  | "network"
  | "user"
  | "custom";

/**
 * Breadcrumb entry
 */
export interface Breadcrumb {
  type: BreadcrumbType;
  timestamp: number;
  message?: string;
  data?: Record<string, any>;
  category?: string;
  level?: "debug" | "info" | "warning" | "error";
}

/**
 * Console log entry
 */
export interface ConsoleLogEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  args: any[];
  timestamp: number;
}

/**
 * Network request summary
 */
export interface NetworkRequest {
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  duration?: number;
  timestamp: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

/**
 * Device and environment information
 */
export interface DeviceInfo {
  userAgent?: string;
  platform?: string;
  language?: string;
  screenResolution?: string;
  viewportSize?: string;
  timezone?: string;
  nodeVersion?: string;
  memoryUsage?: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
}

/**
 * Attachment reference
 */
export interface AttachmentReference {
  id: string;
  name: string;
  type: string;
  size: number;
  url?: string;
  dataUrl?: string;
  kind?: "screenshot" | "file" | "link";
  mimeType?: string;
  annotationScene?: unknown;
}

/** Select an existing server-owned issue destination. */
export interface BugIntegrationHint {
  target?: "github" | "linear";
  project?: string;
}

/** Bug report event carried by the canonical WatchFn transport. */
export interface BugReportEvent {
  /** Local delivery outcome; omitted from the WatchFn envelope. */
  delivery?: "sent" | "local" | "dropped";
  id: string;
  timestamp: number;
  title: string;
  description?: string;
  steps?: string[];
  severity: BugSeverity;
  tags?: string[];

  // Context
  breadcrumbs?: Breadcrumb[];
  consoleLogs?: ConsoleLogEntry[];
  networkRequests?: NetworkRequest[];
  deviceInfo?: DeviceInfo;

  // User context
  user?: {
    id?: string;
    email?: string;
    username?: string;
    [key: string]: any;
  };

  // Environment
  environment?: string;
  release?: string;

  // Attachments
  attachments?: AttachmentReference[];

  // Integration
  integration?: BugIntegrationHint & {
    issueId?: string;
    issueUrl?: string;
  };

  // Custom metadata
  metadata?: Record<string, any>;
}

/**
 * Options for capturing a bug
 */
export interface CaptureBugOptions {
  /** Select an already authorized server route; never include provider credentials. */
  integration?: BugIntegrationHint;
  includeConsoleLogs?: boolean;
  includeNetworkLogs?: boolean;
  title: string;
  description?: string;
  steps?: string[];
  severity?: BugSeverity;
  tags?: string[];
  user?: BugReportEvent["user"];
  environment?: string;
  release?: string;
  metadata?: Record<string, any>;
  attachments?: AttachmentReference[];
}

/**
 * BeforeSend hook function
 * Return null to drop the event
 */
export type BeforeSendHook = (
  event: BugReportEvent
) => BugReportEvent | null | Promise<BugReportEvent | null>;

/**
 * Ignore pattern - string or regex
 */
export type IgnorePattern = string | RegExp;

/**
 * CatchFn configuration
 */
export interface IssueStatusConfig {
  /** Opt in to reporter polling; captureBug itself still acknowledges ingestion only. */
  enabled?: boolean;
  maxAttempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
  /** Trusted authenticated backend alternative to exposing the full Watch key. */
  read?: (reference: BugIssueReference, options: { signal: AbortSignal }) => Promise<BrowserBugIssueStatus | null>;
}

export interface CatchFnConfig {
  issueStatus?: IssueStatusConfig;
  /** Default server route hint. The Watch API key authorizes all routes in its deployment. */
  integration?: BugIntegrationHint;
  watch?: {client: WatchBugReportClient} | WatchEndpointConfig;
  sessionId?: string;
  appVersion?: string;
  env?: string;
  featureFlags?: Record<string, boolean | string>;

  reporter?: {
    floatingButton?: boolean;
    hotkey?: string;
    screenshot?: boolean;
    maskSelectors?: string[];
    maxInlineBytes?: number;
  };
  uploadAttachment?: (blob: Blob, attachment: AttachmentReference) => Promise<{url: string}>;
  network?: {
    allowUrls?: IgnorePattern[];
    blockUrls?: IgnorePattern[];
    allowedHeaders?: string[];
    blockedHeaders?: string[];
  };

  /**
   * Application name
   */
  name: string;

  /**
   * Enable breadcrumb collection
   * @default true
   */
  enableBreadcrumbs?: boolean;

  /**
   * Maximum number of breadcrumbs to keep
   * @default 50
   */
  maxBreadcrumbs?: number;

  /**
   * Enable console log capture
   * @default false
   */
  enableConsoleCapture?: boolean;

  /**
   * Maximum number of console logs to keep
   * @default 100
   */
  maxConsoleLogs?: number;

  /**
   * Enable network request tracking
   * @default false
   */
  enableNetworkCapture?: boolean;

  /**
   * Maximum number of network requests to keep
   * @default 20
   */
  maxNetworkRequests?: number;

  /**
   * Default severity for bug reports
   * @default "medium"
   */
  defaultSeverity?: BugSeverity;

  /**
   * Default environment
   */
  environment?: string;

  /**
   * Release version
   */
  release?: string;

  /**
   * Default user context
   */
  user?: BugReportEvent["user"];

  /**
   * BeforeSend hook
   */
  beforeSend?: BeforeSendHook;

  /**
   * Patterns to ignore
   */
  ignorePatterns?: IgnorePattern[];

  /**
   * Maximum payload size in bytes
   * @default 262144 (256KB)
   */
  maxPayloadSize?: number;

  /**
   * Sensitive fields to redact
   */
  sensitiveFields?: string[];
}

/**
 * Context collector interface
 */
export interface ContextCollector<T = any> {
  collect(): T;
  clear(): void;
}

/** Canonical event carried by the shared WatchFn ingestion transport. */
export interface WatchBugReportEvent {
  id: string;
  type: "bug_report";
  timestamp: string;
  app: {name: string; version?: string};
  user?: BugReportEvent["user"];
  sessionId: string;
  context: Record<string, unknown>;
  report: {title: string; description?: string; steps?: string[]; severity: BugSeverity; tags?: string[]};
  attachments?: AttachmentReference[];
  integration?: BugReportEvent["integration"];
  replayId?: string;
}
/** Uses WatchFn's shared authenticated queue and retry transport. */
export interface WatchEndpointConfig extends Omit<BrowserConfig, "projectId" | "autoTrack" | "sampleRate"> {
  projectId?: string;
}
export interface WatchBugReportClient {
  capture(event: WatchBugReportEvent): Promise<{integration?: BugReportEvent["integration"]} | void>;
  flush?(): Promise<void>;
  readBugIssueStatus?(reference: BugIssueReference, options: { signal: AbortSignal }): Promise<BrowserBugIssueStatus | null>;
}

export type { BugIssueReference, BrowserBugIssueStatus };
