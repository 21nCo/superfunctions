# TestFn

> Comprehensive self-hosted testing platform for developers

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](/LICENSE)
[![Version](https://img.shields.io/npm/v/testfn.svg)](https://www.npmjs.com/package/testfn)

## Overview

TestFn is a developer-first testing solution that combines test execution, analytics, and visual testing into a single self-hosted platform. It provides a unified interface for running tests across multiple frameworks (Vitest, Playwright, Jest) with built-in analytics, flaky test detection, and visual regression testing.

## Features

✅ **Multi-Framework Support**: Vitest, Playwright, Jest, Puppeteer  
✅ **Test Analytics**: Built-in metrics, flaky detection, performance regression  
✅ **Visual Testing**: Screenshot comparison and diff visualization  
✅ **Self-Hosted**: No external dependencies, runs completely offline  
✅ **Storage Options**: IndexedDB, filesystem, or custom database adapters  
✅ **Parallel Execution**: Run tests in parallel for faster feedback  
✅ **Multi-Browser**: Test across Chromium, Firefox, and WebKit

## Installation

```bash
npm install testfn
```

## Quick Start

### Basic Usage

```typescript
import { testFn } from 'testfn';

const runner = testFn({
  framework: 'vitest',
  testPattern: './tests/**/*.test.ts',
  parallel: 4
});

await runner.run();
```

### With Storage

```typescript
import { testFn } from 'testfn';

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
import { testFn } from 'testfn';

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
