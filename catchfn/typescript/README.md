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

## Integration with WatchFn

CatchFn is designed to integrate with [WatchFn](../watchfn) for centralized bug tracking and analysis.

```typescript
import { catchFn } from "catchfn";
// import { watchFn } from "watchfn"; // Future integration

const catcher = catchFn({
  name: "my-app",
  // watchfnClient: watch, // Future: send events to watchfn
});
```

## License

MIT © 21n

## Contributing

See the main [superfunctions repository](https://github.com/21nCo/super-functions) for contribution guidelines.
