# TestFn

> Comprehensive self-hosted testing platform for developers

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](/LICENSE)
[![Version](https://img.shields.io/npm/v/@testfn/core.svg)](https://www.npmjs.com/package/@testfn/core)

## Overview

TestFn is a developer-first testing solution that combines test execution, analytics, and visual testing into a single self-hosted platform. It provides a unified interface for running tests across multiple frameworks (Vitest, Playwright, Jest) with built-in analytics, flaky test detection, and visual regression testing.

## Features

✅ **Multi-Framework Support**: Vitest, Playwright, Jest, Puppeteer
✅ **Test Analytics**: Built-in metrics, flaky detection, performance regression
✅ **Visual Testing**: Screenshot comparison and diff visualization
✅ **Self-Hosted**: Runs locally with installed framework and browser dependencies
✅ **Storage Options**: IndexedDB, filesystem, or custom database adapters
✅ **Parallel Execution**: Run tests in parallel for faster feedback
✅ **Multi-Browser**: Test across Chromium, Firefox, and WebKit

## Installation

```bash
npm install @testfn/core
```

## Quick Start

### Basic Usage

```typescript
import { testFn } from '@testfn/core';

const runner = testFn({
  framework: 'vitest',
  testPattern: './tests/**/*.test.ts',
  parallel: 4
});

await runner.run();
```

### With Storage

```typescript
import { testFn } from '@testfn/core';

const runner = testFn({
  framework: 'playwright',
  testPattern: './e2e/**/*.spec.ts',
  storage: {
    type: 'indexeddb',
    dbName: 'my-app-tests',
    retentionDays: 30
  }
});

const results = await runner.run();
console.log(`Pass rate: ${results.summary.passed / results.summary.total}`);
```

### Multi-Browser Testing

```typescript
import { testFn } from '@testfn/core';

const runner = testFn({
  framework: 'playwright',
  browsers: ['chromium', 'firefox', 'webkit'],
  parallel: 6,
  storage: {
    type: 'indexeddb',
    dbName: 'cross-browser-tests'
  }
});

await runner.run();
```

## Configuration

### TestFnConfig

```typescript
interface TestFnConfig {
  framework: 'vitest' | 'playwright' | 'jest' | 'puppeteer';
  testPattern?: string | string[];
  parallel?: number | 'auto';
  timeout?: number;
  retries?: number;
  env?: Record<string, string>;
  browsers?: BrowserType[] | BrowserConfig[];
  storage?: StorageConfig;
  visual?: VisualTestConfig;
  reporters?: Reporter[];
  onProgress?: (progress: TestProgress) => void;
  onComplete?: (results: TestResults) => void;
}
```

### Storage Configuration

```typescript
interface StorageConfig {
  type: 'indexeddb' | 'file' | 'db';
  dbName?: string;
  adapter?: unknown;
  retentionDays?: number;
}
```

## API Reference

### testFn(config: TestFnConfig): TestRunner

Creates a new test runner instance with the specified configuration.

### TestRunner

#### `async run(): Promise<TestResults>`

Executes the test suite and returns results.

#### `setAdapter(adapter: TestFrameworkAdapter): void`

Sets a custom framework adapter.

### TestStorage

#### `async saveRun(run: TestRun): Promise<void>`

Saves a complete test run to storage.

#### `async getRecentRuns(limit: number): Promise<TestRun[]>`

Retrieves the most recent test runs.

#### `async getTestHistory(testId: string, limit: number): Promise<TestResult[]>`

Gets historical results for a specific test.

## Project Status

**Version**: 0.1.0 (V0 Implementation)
**Status**: Active Development

### Implemented Features

- ✅ Core type system (248 lines)
- ✅ IndexedDB storage layer with retention
- ✅ Test runner with parallel execution
- ✅ Worker pool for true parallelism
- ✅ Retry logic with automatic retries
- ✅ Framework adapters: Vitest, Playwright, Jest
- ✅ Multi-browser testing (Chromium, Firefox, WebKit)
- ✅ Analytics engine (metrics, flaky detection, regressions)
- ✅ Visual testing with pixel diff
- ✅ Reporters: Console, JSON, HTML Dashboard
- ✅ Storage facade with CRUD operations
- ✅ 5 comprehensive examples

### In Progress

- 🚧 SSIM visual comparison
- 🚧 File system storage backend
- 🚧 Puppeteer adapter

### Roadmap

See [SPEC.md](./SPEC.md) for the complete V0 specification and development roadmap.

## Architecture

```
testfn/
├── src/
│   ├── core/           # Test runner and orchestration
│   ├── storage/        # IndexedDB and storage adapters
│   ├── analytics/      # Metrics and flaky detection
│   ├── reporters/      # Console, JSON, HTML reporters
│   ├── visual/         # Screenshot comparison
│   ├── integrations/   # Framework adapters
│   └── types.ts        # Core type definitions
└── examples/           # Usage examples
```

## Examples

Check the `examples/` directory for more usage patterns.

## Contributing

Contributions are welcome! Please read the [SPEC.md](./SPEC.md) for the project vision and implementation plan.

## License

MIT - See [LICENSE](../../LICENSE) for details.

## Part of Super Functions

TestFn is part of the [Super Functions](https://github.com/21nCo/super-functions) ecosystem - building blocks for software development.

## Runtime and execution contract

Node.js 18.18 or newer is required for the core; the optional admin package requires Node.js 20 or newer. Install the selected framework in the consumer project; TestFn invokes its local CLI without a shell or downloading code. Discovery uses file globs. Results contain individual assertions, including each Playwright browser project. `parallel` limits concurrent files; `retries` reruns a failed file and returns its final results with `metadata.attempts`. Skipped cases are not retried. A missing, malformed, empty or unsuccessful framework report cannot produce a passing run.

`timeout` bounds each framework process, including startup. `runner.cancel()` or `signal` terminates active subprocesses and skips queued files. Custom adapters receive the signal and must cooperate with cancellation. `configFile` selects the Playwright configuration; its settings are retained while the requested browsers and selected file are applied. Configure browser launch options in that file. Install browser engines with `npx playwright install` before running the suite.

Puppeteer suites use Node's `node:test` API and launch/close Puppeteer browsers themselves. TestFn collects the Node runner's individual results. Reporters reset between runs; JSON includes results and artifact references, and report write failures reject the run.

For file storage, `dbName` is a directory. Writes are atomic per record; separate processes can reopen the same directory. For database storage, pass a shared `@superfunctions/db` Adapter; TestFn applies its own schema internally. `getTestFnSchema()` (also exported as `getSchema` for the shared CLI) exposes the two table definitions for host-managed migrations. The host must create the physical tables before use. Retention removes expired runs and their artifact records when `storage.cleanup()` is called. Artifact bytes stored in `buffer` are persisted; a path-only artifact remains a reference to the framework's output file.

Analytics return zero metrics for empty runs and ignore skipped cases in flakiness calculations. Percentage duration regressions require a positive baseline duration; zero-duration baselines are excluded. Visual `threshold` is between zero and one; zero permits exact matches. `updateBaselines` replaces existing baselines as well as creating missing ones. Screenshot names may use relative subdirectories but cannot escape the configured directory.

## Visual comparisons and baseline approval

```ts
import { VisualTester, visualTest } from '@testfn/core';

const visual = new VisualTester({
  baselineDir: './baselines',
  diffDir: './visual-evidence',
  environment: { browser: 'chromium', viewport: { width: 1280, height: 720 } },
  algorithm: 'ssim',
  ssimThreshold: 0.99,
  approvalRequired: true,
  fullPage: true,
});
const current = await visual.captureScreenshot(page, 'homepage');
// First comparison stages a proposal and throws until a baseline is approved.
// Later failed comparisons stage replacements while preserving approved bytes.
await visual.compareScreenshot(current, 'homepage');

const pending = await visual.baselines.getPending('homepage');
if (pending) {
  // Present pending.screenshot to the authorized human/operator first.
  await visual.baselines.approve('homepage', pending.revision);
  // Or: await visual.baselines.reject('homepage', pending.revision);
}
```

`BaselineManager` is also exported independently. `store` stages a pending screenshot; `retrieve` reads only the approved screenshot; `listPending` lists pending names. Pending and approved snapshots survive reconstruction, and approval/rejection can require the revision shown to the operator. Replacement proposals cannot change approved bytes. Atomic file replacement protects each snapshot against partial writes. Use one writer process per baseline directory; these local files do not provide cross-process transactional compare-and-swap or authorization. Hosts must authorize approve/reject operations. `updateBaselines` never automatically passes a proposal when `approvalRequired` is enabled.

The optional environment object separates baselines and evidence by browser, viewport, and an application-defined `name`; using a different environment never reuses another environment's baseline. Capture options can override `fullPage` and attach environment metadata; the configured environment controls storage isolation. Existing `captureScreenshot(name, pngBuffer)` calls remain supported, as do `compareScreenshot(current, baselineScreenshot)` and `compareScreenshot(current, storedName)`.

Pixel comparison remains the default. SSIM uses luminance, white-background alpha compositing, non-overlapping 8×8 windows (including partial edge windows), population covariance, and Wang-style constants K1=0.01/K2=0.03 for 8-bit pixels. `ssimThreshold` determines acceptance in SSIM mode; `threshold` continues to control pixel comparison tolerance. Results include the SSIM score, pixel counts, and bounding changed regions. Different dimensions always fail. PNG input is limited to 64 MiB compressed and 16 million pixels before decompression.

Every completed comparison writes a side-by-side PNG and a self-contained HTML viewer with an accessible before/after slider. `getComparison(name)` returns `{ image, html }`; `getDiff(name)` returns the current highlighted diff or null. Generated PNGs contain a `TestFn` iTXt metadata chunk. Identical comparisons remove obsolete diffs; dimension mismatches replace prior diff evidence. HTML embeds its images, escapes titles, and needs no server or network access.

`visualTest(page, name, config?)` captures and asserts a screenshot, rejecting failed comparisons. A runner's `visual` configuration is propagated to child framework processes through `TESTFN_VISUAL_CONFIG`; the helper uses it when no explicit config is supplied. `diffDir` defaults to `${baselineDir}-diffs`. Framework tests import this helper themselves. Baseline approval remains explicit, outside the test assertion.

Artifact references use `getArtifactId(runId, testId, type, index)`; `run.artifacts` and admin result `artifactIds` expose these identifiers. Existing stored artifact IDs remain readable. New IDs encode the complete tuple without separator collisions. `saveArtifactStream(metadata, asyncBytes)` writes bounded 64 KiB chunks; logs and traces are gzip-compressed per chunk. `getArtifactStream(id)` yields decoded bytes incrementally, including path-only artifact files. `getArtifact(id)` assembles persisted chunks for callers needing a Buffer. Persisted run records contain artifact references rather than duplicate binary payloads. Replacing an artifact removes its previous chunks; retention removes its manifest and associated chunks.

For browser IndexedDB use the browser-safe entry point `@testfn/core/storage/indexeddb`. This module entry emits modern JavaScript. A standalone ES5 browser distribution is described below; the historical browser floors in the original specification still require exact-version validation. Native Safari acceptance is also pending; Playwright WebKit tests do not establish Safari compatibility. The orchestration, file/database storage, reports and visual processing entries run in Node.js.

## Analytics and offline dashboard

`AnalyticsEngine.registerMetric(name, compute)` registers a finite numeric metric over a stored run; `computeCustomMetrics(runId)` evaluates the definitions. `getCoverageTrends(days)` returns supplied summary coverage chronologically. `testSignificance(baseline, current, {alpha, iterations, seed})` performs a reproducible two-sided permutation test over numeric samples; its p-value is separate from the practical duration thresholds used by `findRegressions`.

With storage open, `await generateDashboard(storage, './dashboard', {limit:100, comparisons:[{name, baseline, current}]})` exports standalone overview, test/history, visual and analytics pages plus `data/runs.json`. Pages embed their data, use no CDN or build step, and work offline. The explicit `limit` controls the exported history window. Comparison inputs are captured `Screenshot` objects; the visual page embeds the baseline/current slider.

`deviceBrowser('chromium', deviceProfile)` converts a device profile into a browser configuration with viewport, user agent, scale, mobile and touch settings. `applyNetworkProfile(page, networkProfiles.offline)` works through the browser context; its returned async cleanup function restores online access. `fast3g`, `slow3g` and custom bandwidth/latency profiles use Chromium CDP and reject unsupported browsers explicitly. Throughput uses Mbps and latency uses milliseconds. Call these helpers in your framework's setup/beforeEach hook and clean up afterward.

Storage automatically applies retention every 100 saved runs. Set `cleanupThreshold` to another nonnegative write count, or zero to disable automatic cleanup. `cleanup(days?)` can override the configured retention for an explicit cleanup.

### Standalone IndexedDB browser distribution

The package includes `@testfn/core/storage/indexeddb-browser`, a classic-script bundle exposing `TestFnBrowser.IndexedDbManager`. Serve the resolved file as a normal script, then create a manager with `{ dbName: "test-history" }`. It uses the browser's native IndexedDB (including prefixed factories), includes runtime polyfills, and contains no in-memory IndexedDB fallback. The build parses the complete bundle as ES5.

The browser acceptance fixture checks the shipped bundle both normally and with native Promise, microtask helpers, array methods and unprefixed IndexedDB globals removed. Cleanup queues dependent requests directly from IndexedDB events so a task-based Promise polyfill does not prematurely commit its transaction. These checks reduce the compatibility gap; they do not substitute for exact Chrome 24, Firefox 16, Safari 10 and Edge 12 runtime validation, which remains outstanding.

### Explicit framework workspace

`new TestRunner({ framework: 'vitest', cwd: '/absolute/project', reporters: [] })`
resolves and canonicalizes the workspace once when `run()` starts, before asynchronous
work. Omitting `cwd` snapshots the caller's current directory. Built-in adapters use
that directory for discovery, installed framework resolution, subprocess execution,
Playwright configuration/output, and path-only framework artifacts. Relative
`configFile` values refer to this workspace. No host `process.chdir()` is performed;
independent runners can execute different workspaces concurrently.

Custom adapters receive `{ cwd }` as the optional second argument to `discover` and
in `RunOptions`; they must honor it and avoid global directory changes. Caller-owned
reporters, storage configurations and custom callbacks retain their own path semantics;
use absolute paths for them when the host may change its directory. This is directory
isolation, not a sandbox for arbitrary test code. Framework timeout/cancellation still
uses the existing subprocess and process-group supervisor.

`node testfn/typescript/scripts/verify-workspaces.mjs` checks concurrent Vitest, Jest,
Playwright and Node-test/Puppeteer-adapter fixtures using installed frameworks. It does
not launch browsers or establish browser-engine readiness.
