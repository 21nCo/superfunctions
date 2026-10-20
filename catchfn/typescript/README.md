# CatchFn

> Self-hosted bug reporting and context collection for developers

CatchFn is a lightweight SDK for capturing bug reports with rich context including breadcrumbs, console logs, network activity, and device information. It's designed to integrate seamlessly with your development workflow and the superfunctions ecosystem.

## Features

- 🍞 **Breadcrumb Tracking** - Automatic navigation, console, and network breadcrumbs
- 📝 **Console Capture** - Optional console log buffering
- 🌐 **Network Monitoring** - Track HTTP requests with automatic header redaction
- 🔒 **Data Redaction** - Built-in sensitive data protection
- 🎣 **Hooks System** - `beforeSend` hooks for custom processing
- 🚫 **Ignore Patterns** - Filter unwanted reports
- 📦 **Size Limiting** - Automatic payload size optimization
- 🔧 **TypeScript-First** - Full type safety and inference

## Installation

```bash
npm install catchfn
```

## Quick Start

```typescript
import { catchFn } from "catchfn";

// Initialize CatchFn
const catcher = catchFn({
  name: "my-app",
  environment: "production",
  enableBreadcrumbs: true,
  enableConsoleCapture: true,
  enableNetworkCapture: false,
});

// Add breadcrumbs manually
catcher.addBreadcrumb({
  type: "navigation",
  message: "User navigated to dashboard",
  data: { from: "/home", to: "/dashboard" },
});

// Capture a bug report
const report = await catcher.captureBug({
  title: "Payment failed",
  description: "User encountered error during checkout",
  severity: "high",
  tags: ["payment", "checkout"],
  user: {
    id: "user-123",
    email: "user@example.com",
  },
});

console.log("Bug report ID:", report.id);
```

## Deliver through WatchFn

```typescript
const catcher = catchFn({
  name: "shop",
  watch: {
    endpoint: "https://watch.example/ingest",
    apiKey: () => currentWatchKey,
    retries: 2,
    retryDelayMs: 250,
    timeoutMs: 10000,
  },
});
await catcher.captureBug({ title: "Checkout failed", severity: "high" });
await catcher.flush();
catcher.stop();
```

Endpoint configuration uses `@watchfn/browser`'s shared queue, bearer authentication and bounded retry transport. The canonical `bug_report` envelope is stored unchanged by WatchFn; ingestion must include canonical bug-report support. Successful capture waits for an HTTP acknowledgement. Failed events remain queued for an explicit `flush()` retry; capture rejects on authorization, exhausted transport or storage errors. Calling `captureBug` again creates a new report. Use `CatchFnDeliveryError.retry()` to retry the prepared report with its original ID and payload; it also handles a report that could not enter a full queue. `flush()` retries events already accepted into the queue.

```ts
import { CatchFnDeliveryError } from "catchfn";

try {
  await catcher.captureBug({ title: "Save failed" });
} catch (error) {
  if (!(error instanceof CatchFnDeliveryError)) throw error;
  // Invoke after recovery or an explicit user retry. Failure still rejects.
  await error.retry();
}
```

The widget locks the prepared details after a delivery failure and offers **Retry same report**. **Start a new report** explicitly creates a separate report; the queued original can still arrive. Retries reuse the prepared attachments and hooks, and concurrent retries share one attempt. A response timeout after successful storage can still produce duplicate arrivals with the same ID: delivery is at least once, without server deduplication. The queue is in memory; page reload, unload delivery and persistent offline recovery are not guaranteed. Cross-origin hosts must explicitly permit the browser origin, `POST`, `Authorization` and `Content-Type` in their CORS policy.


This path defaults to WatchFn's 64 KiB per-event limit and rejects larger configured limits. Upload larger attachments through `uploadAttachment` and send references. Without `watch`, capture remains local. Existing `watch: { client }` injection remains supported with its own payload limit. Transport is at least once: retries after a lost response can store duplicate arrivals with the same report ID. WatchFn HTTP query filters can select `type: "bug_report"`, `app.name`, severity, tags and timestamp; per-report deduplication and retention policy are separate open gates.

## Configuration

```typescript
interface CatchFnConfig {
  // Required
  name: string;

  // Breadcrumbs
  enableBreadcrumbs?: boolean; // default: true
  maxBreadcrumbs?: number; // default: 50

  // Console capture
  enableConsoleCapture?: boolean; // default: false
  maxConsoleLogs?: number; // default: 100

  // Network capture
  enableNetworkCapture?: boolean; // default: false
  maxNetworkRequests?: number; // default: 20

  // Bug settings
  defaultSeverity?: "low" | "medium" | "high" | "critical"; // default: "medium"
  environment?: string;
  release?: string;
  user?: { id?: string; email?: string; [key: string]: any };

  // Hooks and filters
  beforeSend?: (event: BugReportEvent) => BugReportEvent | null;
  ignorePatterns?: (string | RegExp)[];

  // Size limits
  maxPayloadSize?: number; // default: 262144 (256KB)
  sensitiveFields?: string[]; // Additional fields to redact
}
```

## Usage Examples

### Basic Bug Capture

```typescript
await catcher.captureBug({
  title: "API request failed",
  description: "Failed to fetch user data",
  severity: "medium",
  tags: ["api", "network"],
});
```

### With User Context

```typescript
await catcher.captureBug({
  title: "Feature access denied",
  description: "User tried to access premium feature",
  severity: "low",
  user: {
    id: "user-123",
    email: "user@example.com",
    plan: "free",
  },
  metadata: {
    feature: "analytics-dashboard",
    requestedAt: new Date().toISOString(),
  },
});
```

### Using beforeSend Hook

```typescript
const catcher = catchFn({
  name: "my-app",
  beforeSend: (event) => {
    // Add custom data
    event.metadata = {
      ...event.metadata,
      buildNumber: "1.2.3",
    };

    // Filter internal users
    if (event.user?.email?.endsWith("@company.com")) {
      return null; // Drop the event
    }

    return event;
  },
});
```

### Ignore Patterns

```typescript
const catcher = catchFn({
  name: "my-app",
  ignorePatterns: ["ResizeObserver loop", /network.*timeout/i],
});

// This will be ignored
await catcher.captureBug({
  title: "ResizeObserver loop limit exceeded",
  description: "Browser warning",
});
```

### Manual Breadcrumbs

```typescript
// Navigation
catcher.addBreadcrumb({
  type: "navigation",
  message: "User navigated to settings",
  data: { from: "/dashboard", to: "/settings" },
});

// User interaction
catcher.addBreadcrumb({
  type: "user",
  message: "Button clicked",
  data: { button: "submit-form" },
});

// Custom
catcher.addBreadcrumb({
  type: "custom",
  message: "Payment processed",
  data: { amount: 99.99, currency: "USD" },
  level: "info",
});
```

## API Reference

### `catchFn(config: CatchFnConfig)`

Factory function to create a new CatchFn instance.

### `CatchFn.captureBug(options: CaptureBugOptions)`

Capture a bug report with context.

**Returns:** `Promise<BugReportEvent>`

### `CatchFn.addBreadcrumb(breadcrumb: Breadcrumb)`

Manually add a breadcrumb.

### `CatchFn.beforeSend(hook: BeforeSendHook)`

Register a beforeSend hook.

### `CatchFn.addIgnorePattern(pattern: IgnorePattern)`

Add a pattern to ignore.

### `CatchFn.clear()`

Clear all collected context (breadcrumbs, logs, network requests).

### `CatchFn.stop()`

Stop all collectors (console, network interceptors).

### `CatchFn.getConfig()`

Get the current configuration.

## Advanced Usage

### Using Collectors Directly

```typescript
import { BreadcrumbCollector } from "catchfn";

const breadcrumbs = new BreadcrumbCollector(100);

breadcrumbs.addNavigation("/home", "/profile");
breadcrumbs.addUser("click", "edit-button");

const collected = breadcrumbs.collect();
console.log(collected);
```

### Data Redaction

```typescript
import { redactObject, redactUrl } from "catchfn";

const data = {
  username: "john",
  password: "secret123", // Will be redacted
  apiKey: "abc123", // Will be redacted
};

const redacted = redactObject(data);
// { username: "john", password: "[REDACTED]", apiKey: "[REDACTED]" }

const url = redactUrl("https://api.example.com?token=secret&id=123");
// "https://api.example.com?token=[REDACTED]&id=123"
```

## Reporter and delivery

```typescript
import { catchFn, type WatchBugReportClient } from "catchfn";

// Supply an application-owned client implementing the canonical capture contract.
declare const client: WatchBugReportClient;
const catcher = catchFn({
  name: "my-app",
  watch: { client },
  reporter: { floatingButton: true, hotkey: "alt+b" },
});
await catcher.openReporter();
// Call when the owning application/component is disposed.
catcher.stop();
```

The reporter provides masked screenshots, DrawFn annotation, title/description/steps,
severity/tags and console/network consent. Use `data-catchfn-mask` on private DOM
content; password and payment inputs are masked automatically. Additional selectors
can be configured through `reporter.maskSelectors`. Large screenshots require an
`uploadAttachment(blob, attachment)` callback returning an HTTP(S) URL; the default
inline limit is 64 KiB. Screenshot bytes and annotation metadata count toward the
final payload limit.

React applications can render `CatchFnReporterButton` from `catchfn/react` with a
`catcher` prop and optional `onReporterError` handler. The application owns SDK
creation and cleanup.

`captureBug()` awaits the injected client's `capture()` and reports `delivery` as
`sent`, `local`, or `dropped`. Without a client it only returns the local report.
A rejected delivery promise is surfaced to the caller. The client receives the
canonical `type: "bug_report"` envelope with ISO timestamp, app, session, context,
report and attachment fields. `flush()` delegates to the client's optional flush.

The default WatchFn endpoint/authentication/retry implementation and shared datastore
integration are still outstanding. This injected-client contract is not a completed
WatchFn ingestion integration. See `../.conduct/readiness.md` for the full remaining
acceptance gates.

## License

MIT © 21n

## Contributing

See the main [superfunctions repository](https://github.com/21nCo/super-functions) for contribution guidelines.
