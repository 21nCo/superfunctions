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
}

/**
 * Bug report event - the main event sent to watchfn
 */
export interface BugReportEvent {
  id: string;
  timestamp: number;
  title: string;
  description?: string;
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
  integration?: {
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
  title: string;
  description?: string;
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
export interface CatchFnConfig {
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
