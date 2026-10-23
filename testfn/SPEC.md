# TestFn V0 Specification

> Comprehensive self-hosted testing platform for developers

## Overview

TestFn is a developer-first testing solution that combines test execution, analytics, and visual testing into a single self-hosted platform. It builds on the super-functions ecosystem, reusing proven patterns from searchfn and @superfunctions/db.

**Version**: 0.1.0  
**Target Release**: Q1 2026  
**Status**: Specification

## Core Philosophy

- **Self-hosted first**: No external dependencies or cloud services
- **Developer experience**: Simple SDK, works locally, minimal configuration
- **Comprehensive**: Unit, integration, E2E, and visual testing in one tool
- **Performance**: Fast execution, efficient storage, real-time analytics
- **Ecosystem integration**: Leverages super-functions infrastructure

## Architecture

```
testfn/
├── ts-sdk/
│   ├── src/
│   │   ├── core/           # Test orchestration & execution
│   │   ├── storage/        # Results persistence layer
│   │   ├── analytics/      # Metrics, trends, flaky detection
│   │   ├── reporters/      # Output formatters (HTML, JSON, console)
│   │   ├── visual/         # Screenshot comparison & diffing
│   │   └── integrations/   # Framework adapters (Vitest, Playwright)
│   └── examples/
├── py-sdk/                 # Python SDK (future)
└── dashboard/              # Static HTML viewer
```

## V0 Features

### 1. Test Execution & Orchestration

#### Test Runner Core
**Priority**: P0 (Critical)

Provides the foundation for running tests across different frameworks.

**Capabilities**:
- Framework detection and adapter loading
- Test discovery and filtering
- Parallel execution with worker pool
- Result collection and aggregation
- Error handling and retry logic

**API Design**:
```typescript
interface TestFnConfig {
  framework: 'vitest' | 'playwright' | 'jest' | 'puppeteer';
  testPattern?: string | string[];
  parallel?: number | 'auto';
  timeout?: number;
  retries?: number;
  env?: Record<string, string>;
  browsers?: ('chromium' | 'firefox' | 'webkit')[];
  storage?: StorageConfig;
  onProgress?: (progress: TestProgress) => void;
  onComplete?: (results: TestResults) => void;
}

interface StorageConfig {
  type: 'indexeddb' | 'file' | 'db';
  dbName?: string;
  adapter?: Adapter;
  retentionDays?: number;
}

const runner = testFn({
  framework: 'playwright',
  testPattern: './tests/**/*.spec.ts',
  parallel: 4,
  browsers: ['chromium', 'firefox'],
  storage: {
    type: 'indexeddb',
    dbName: 'testfn-results'
  },
  onProgress: (progress) => {
    console.log(`${progress.completed}/${progress.total}`);
  }
});

await runner.run();
```

**Implementation Notes**:
- Reuse worker pool pattern from `searchfn/examples/bulk-indexing-worker.ts`
- Support both in-process and isolated worker execution
- Handle stdout/stderr capture per test
- Provide cancellation support

#### Framework Adapters
**Priority**: P0 (Critical)

Standardized interfaces for test framework integration.

**Supported Frameworks (V0)**:
- **Vitest**: Native TypeScript/JavaScript testing
- **Playwright**: E2E browser testing
- **Jest**: Legacy test support
- **Puppeteer**: Browser automation

**Adapter Interface**:
```typescript
interface TestFrameworkAdapter {
  name: string;
  discover(pattern: string[]): Promise<TestCase[]>;
  run(tests: TestCase[], options: RunOptions): Promise<TestResult[]>;
  supports(framework: string): boolean;
}

interface TestCase {
  id: string;
  file: string;
  name: string;
  suite?: string;
  tags?: string[];
}

interface TestResult {
  id: string;
  status: 'passed' | 'failed' | 'skipped' | 'timeout';
  duration: number;
  error?: TestError;
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

interface TestError {
  message: string;
  stack?: string;
  expected?: unknown;
  actual?: unknown;
  diff?: string;
}

interface Artifact {
  type: 'screenshot' | 'video' | 'trace' | 'log';
  path: string;
  buffer?: Buffer;
  metadata?: Record<string, unknown>;
}
```

**Implementation Strategy**:
- Create base adapter class with common functionality
- Implement framework-specific subclasses
- Handle framework CLI invocation and output parsing
- Standardize error formats across frameworks

### 2. Storage & Persistence

#### Storage Layer
**Priority**: P0 (Critical)

Efficient storage for test results, artifacts, and historical data.

**Storage Backends**:
- **IndexedDB**: Browser/local development (reuse `searchfn/src/storage/indexeddb-manager.ts`)
- **File System**: CI/CD environments, simple persistence
- **Database Adapters**: Production use via `@superfunctions/db`

**Schema Design**:
```typescript
interface TestRun {
  id: string;
  timestamp: number;
  branch?: string;
  commit?: string;
  author?: string;
  environment: EnvironmentInfo;
  summary: TestRunSummary;
  results: TestResult[];
}

interface TestRunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  coverage?: CoverageData;
}

interface EnvironmentInfo {
  platform: string;
  nodeVersion?: string;
  browser?: BrowserInfo;
  ci?: boolean;
}

interface BrowserInfo {
  name: string;
  version: string;
  headless: boolean;
}
```

**Storage API**:
```typescript
class TestStorage {
  async saveRun(run: TestRun): Promise<void>;
  async getRun(id: string): Promise<TestRun | null>;
  async getRecentRuns(limit: number): Promise<TestRun[]>;
  async getTestHistory(testId: string, limit: number): Promise<TestResult[]>;
  async saveArtifact(artifact: Artifact): Promise<string>;
  async getArtifact(id: string): Promise<Artifact | null>;
  async cleanup(retentionDays: number): Promise<void>;
}
```

**Object Stores** (IndexedDB):
```typescript
// Store names
const STORES = {
  runs: 'testfn_runs',
  results: 'testfn_results', 
  artifacts: 'testfn_artifacts',
  metadata: 'testfn_metadata'
};

// Indexes
runs: {
  keyPath: 'id',
  indexes: ['timestamp', 'branch', 'commit']
}

results: {
  keyPath: ['runId', 'testId'],
  indexes: ['status', 'duration', 'timestamp']
}

artifacts: {
  keyPath: 'id',
  indexes: ['runId', 'testId', 'type']
}
```

**Implementation Notes**:
- Reuse IndexedDB patterns from `searchfn/src/storage/indexeddb-manager.ts`
- Implement chunking for large artifacts (screenshots, videos)
- Add compression for text artifacts (logs, traces)
- Support streaming reads for large files

### 3. Analytics & Metrics

#### Metrics Engine
**Priority**: P1 (High)

Real-time and historical analysis of test results.

**Core Metrics**:
- **Execution Time**: Per-test, per-suite, per-run trends
- **Flaky Detection**: Tests with inconsistent results
- **Performance Regression**: Significant duration increases
- **Failure Patterns**: Common error types and locations
- **Coverage Trends**: Code coverage over time

**Analytics API**:
```typescript
interface AnalyticsEngine {
  computeMetrics(runId: string): Promise<RunMetrics>;
  detectFlaky(testId: string, windowSize: number): Promise<FlakyAnalysis>;
  findRegressions(baseline: string, current: string): Promise<Regression[]>;
  getTrends(testId: string, days: number): Promise<TrendData>;
}

interface RunMetrics {
  successRate: number;
  avgDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  failuresByType: Record<string, number>;
}

interface FlakyAnalysis {
  testId: string;
  flakyScore: number;
  passRate: number;
  recentResults: boolean[];
  recommendation: 'investigate' | 'quarantine' | 'stable';
}

interface Regression {
  testId: string;
  metric: 'duration' | 'memory' | 'coverage';
  baseline: number;
  current: number;
  change: number;
  significant: boolean;
}

interface TrendData {
  testId: string;
  dataPoints: Array<{
    timestamp: number;
    value: number;
    status: string;
  }>;
}
```

**Flaky Test Detection Algorithm**:
```typescript
function detectFlaky(results: TestResult[]): FlakyAnalysis {
  const windowSize = 10;
  const recentResults = results.slice(-windowSize).map(r => r.status === 'passed');
  const passRate = recentResults.filter(Boolean).length / recentResults.length;
  
  // Score based on pass rate and volatility
  let flakyScore = 0;
  if (passRate > 0.2 && passRate < 0.8) {
    flakyScore = 1 - Math.abs(passRate - 0.5) * 2;
  }
  
  let recommendation: 'investigate' | 'quarantine' | 'stable';
  if (flakyScore > 0.7) recommendation = 'quarantine';
  else if (flakyScore > 0.4) recommendation = 'investigate';
  else recommendation = 'stable';
  
  return { testId, flakyScore, passRate, recentResults, recommendation };
}
```

**Performance Regression Detection**:
```typescript
function detectRegression(
  baseline: TestResult[], 
  current: TestResult[]
): Regression[] {
  const regressions: Regression[] = [];
  
  for (const test of current) {
    const baselineTest = baseline.find(t => t.id === test.id);
    if (!baselineTest) continue;
    
    const change = (test.duration - baselineTest.duration) / baselineTest.duration;
    
    // Flag if >20% slower and >100ms absolute increase
    if (change > 0.2 && (test.duration - baselineTest.duration) > 100) {
      regressions.push({
        testId: test.id,
        metric: 'duration',
        baseline: baselineTest.duration,
        current: test.duration,
        change,
        significant: change > 0.5
      });
    }
  }
  
  return regressions;
}
```

**Implementation Notes**:
- Use rolling window calculations for efficiency
- Cache computed metrics with invalidation strategy
- Support custom metric definitions
- Provide statistical significance testing

### 4. Visual Testing

#### Screenshot Comparison
**Priority**: P1 (High)

Automated visual regression detection for UI tests.

**Capabilities**:
- Capture screenshots during test runs
- Pixel-by-pixel comparison with baselines
- Structural similarity (SSIM) scoring
- Diff visualization with highlights
- Baseline management and approval workflow

**Visual Testing API**:
```typescript
interface VisualTestConfig {
  baselineDir: string;
  diffDir: string;
  threshold?: number;
  updateBaselines?: boolean;
  fullPage?: boolean;
}

class VisualTester {
  async captureScreenshot(
    page: Page, 
    name: string, 
    options?: CaptureOptions
  ): Promise<Screenshot>;
  
  async compareScreenshot(
    current: Screenshot, 
    baseline: Screenshot
  ): Promise<ComparisonResult>;
  
  async updateBaseline(name: string, screenshot: Screenshot): Promise<void>;
  
  async getDiff(name: string): Promise<DiffImage | null>;
}

interface Screenshot {
  name: string;
  buffer: Buffer;
  width: number;
  height: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface ComparisonResult {
  passed: boolean;
  similarity: number;
  pixelDiffCount: number;
  diffPercentage: number;
  diffImage?: Buffer;
  regions?: DiffRegion[];
}

interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  severity: 'minor' | 'major';
}
```

**Comparison Algorithms**:

1. **Pixel Diff** (Fast, strict):
```typescript
function pixelDiff(img1: Buffer, img2: Buffer): number {
  let diffPixels = 0;
  for (let i = 0; i < img1.length; i += 4) {
    const dr = Math.abs(img1[i] - img2[i]);
    const dg = Math.abs(img1[i+1] - img2[i+1]);
    const db = Math.abs(img1[i+2] - img2[i+2]);
    
    if (dr > threshold || dg > threshold || db > threshold) {
      diffPixels++;
    }
  }
  return diffPixels;
}
```

2. **SSIM** (Structural, perceptual):
```typescript
function ssim(img1: Buffer, img2: Buffer): number {
  // Structural Similarity Index
  // More tolerant to minor rendering differences
  // Returns 0-1 (1 = identical)
  // Implementation based on Wang et al. 2004
}
```

**Diff Visualization**:
- Generate side-by-side comparison images
- Highlight changed regions with red overlay
- Provide slider for before/after comparison
- Export diff as PNG with metadata

**Baseline Management**:
```typescript
interface BaselineManager {
  store(name: string, screenshot: Screenshot): Promise<void>;
  retrieve(name: string): Promise<Screenshot | null>;
  approve(name: string): Promise<void>;
  reject(name: string): Promise<void>;
  listPending(): Promise<string[]>;
}
```

**Implementation Notes**:
- Use canvas API or sharp/jimp for image processing
- Store baselines in separate directory structure
- Support multiple baselines per environment (browser, viewport)
- Implement lazy loading for large image sets

### 5. Multi-Browser Testing

#### Browser Matrix
**Priority**: P1 (High)

Run tests across multiple browsers and configurations.

**Supported Browsers (V0)**:
- Chromium (latest stable)
- Firefox (latest stable)
- WebKit (latest stable)

**Configuration**:
```typescript
interface BrowserConfig {
  name: 'chromium' | 'firefox' | 'webkit';
  headless?: boolean;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  permissions?: string[];
  geolocation?: { latitude: number; longitude: number };
}

const config: TestFnConfig = {
  framework: 'playwright',
  browsers: [
    { name: 'chromium', viewport: { width: 1920, height: 1080 } },
    { name: 'firefox', viewport: { width: 1920, height: 1080 } },
    { name: 'webkit', viewport: { width: 1920, height: 1080 } }
  ]
};
```

**Network Conditions**:
```typescript
interface NetworkProfile {
  name: string;
  downloadThroughput: number;
  uploadThroughput: number;
  latency: number;
}

const profiles = {
  fast3g: { downloadThroughput: 1.6, uploadThroughput: 0.75, latency: 40 },
  slow3g: { downloadThroughput: 0.4, uploadThroughput: 0.4, latency: 400 },
  offline: { downloadThroughput: 0, uploadThroughput: 0, latency: 0 }
};
```

**Device Emulation**:
```typescript
interface DeviceProfile {
  name: string;
  userAgent: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

const devices = {
  'iPhone 13': {
    userAgent: 'Mozilla/5.0...',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  }
};
```

### 6. Reporting & Dashboard

#### Console Reporter
**Priority**: P0 (Critical)

Real-time test execution output.

```typescript
class ConsoleReporter {
  onTestStart(test: TestCase): void;
  onTestComplete(result: TestResult): void;
  onRunComplete(summary: TestRunSummary): void;
}
```

**Output Format**:
```
TestFn v0.1.0

Running 124 tests across 3 browsers...

✓ tests/auth/login.spec.ts (chromium) - 342ms
✓ tests/auth/login.spec.ts (firefox) - 389ms
✗ tests/auth/login.spec.ts (webkit) - 421ms
  Error: Expected "Welcome" but got "Loading..."
  at tests/auth/login.spec.ts:23:5

Progress: 45/124 (36%)

Test Suites: 8 passed, 1 failed, 9 total
Tests:       45 passed, 1 failed, 46 total
Duration:    12.4s
```

#### JSON Reporter
**Priority**: P0 (Critical)

Machine-readable output for CI/CD integration.

```typescript
interface JsonReport {
  version: string;
  timestamp: number;
  summary: TestRunSummary;
  results: TestResult[];
  artifacts: ArtifactReference[];
  metadata: Record<string, unknown>;
}
```

#### HTML Dashboard
**Priority**: P1 (High)

Static HTML viewer for test results and analytics.

**Pages**:
1. **Overview**: Run summary, trends, flaky tests
2. **Test Details**: Individual test results, history
3. **Visual Diffs**: Screenshot comparisons
4. **Analytics**: Performance charts, failure analysis

**Dashboard Structure**:
```
dashboard/
├── index.html          # Overview page
├── test.html           # Test detail view
├── visual.html         # Visual diff viewer
├── analytics.html      # Charts and trends
├── assets/
│   ├── styles.css      # Minimal styling
│   ├── charts.js       # Chart rendering
│   └── diff.js         # Image comparison UI
└── data/
    └── runs.json       # Test run data
```

**Implementation**:
- Pure HTML/CSS/JS (no build step)
- Inline SVG charts or lightweight charting library
- Image slider for visual diffs
- Responsive design for mobile viewing
- Export individual reports as standalone HTML

## Technical Implementation

### Dependencies

**Core**:
- TypeScript 5.6+
- Node.js 18+

**Storage**:
- fake-indexeddb (for Node.js IndexedDB support)
- @superfunctions/db (database adapters)

**Test Frameworks** (peer dependencies):
- vitest ^3.2.4
- playwright ^1.40.0
- jest ^29.0.0
- puppeteer ^21.0.0

**Image Processing**:
- sharp (Node.js) or canvas (browser)
- pixelmatch (pixel diff)

**Utilities**:
- glob (file pattern matching)
- chalk (terminal colors)
- ora (spinners)

### Performance Targets

**V0 Benchmarks**:
- Store 1000 test results in <500ms
- Query test history (<100 results) in <50ms
- Screenshot comparison in <200ms per image
- Dashboard load time <1s for 100 runs
- Support 10,000+ tests per run

### Storage Limits

**IndexedDB**:
- Max database size: Browser-dependent (typically ~50MB+)
- Artifact retention: 30 days default
- Automatic cleanup on threshold

**File System**:
- No hard limits
- Configurable retention policy
- Compression for artifacts

### Browser Compatibility

**IndexedDB Storage**:
- Chrome 24+
- Firefox 16+
- Safari 10+
- Edge 12+

**Dashboard**:
- Modern browsers with ES6 support
- No IE11 support

## API Examples

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

### Multi-Browser

```typescript
import { testFn } from 'testfn';

const runner = testFn({
  framework: 'playwright',
  browsers: ['chromium', 'firefox', 'webkit'],
  parallel: 6
});

await runner.run();
```

### Visual Testing

```typescript
import { testFn, visualTest } from 'testfn';

const runner = testFn({
  framework: 'playwright',
  visual: {
    baselineDir: './tests/baselines',
    threshold: 0.1
  }
});

test('homepage looks correct', async ({ page }) => {
  await page.goto('https://example.com');
  await visualTest(page, 'homepage');
});

await runner.run();
```

### Analytics

```typescript
import { TestStorage, AnalyticsEngine } from 'testfn';

const storage = new TestStorage({ type: 'indexeddb', dbName: 'tests' });
const analytics = new AnalyticsEngine(storage);

const recentRuns = await storage.getRecentRuns(10);
const flakyTests = await analytics.detectFlaky('test-123', 10);

console.log(`Flaky score: ${flakyTests.flakyScore}`);
```

### Custom Reporter

```typescript
import { testFn, Reporter } from 'testfn';

class SlackReporter implements Reporter {
  async onRunComplete(summary: TestRunSummary) {
    await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      body: JSON.stringify({
        text: `Tests: ${summary.passed}/${summary.total} passed`
      })
    });
  }
}

const runner = testFn({
  framework: 'vitest',
  reporters: [new SlackReporter()]
});

await runner.run();
```

## Development Roadmap

### Phase 1: Foundation (Weeks 1-2)
- [ ] Core test runner architecture
- [ ] Framework adapter interface
- [ ] Vitest adapter implementation
- [ ] Basic storage layer (IndexedDB)
- [ ] Console reporter

### Phase 2: Execution (Weeks 3-4)
- [ ] Parallel execution with workers
- [ ] Playwright adapter
- [ ] Multi-browser support
- [ ] Artifact capture and storage
- [ ] JSON reporter

### Phase 3: Analytics (Weeks 5-6)
- [ ] Metrics engine
- [ ] Flaky test detection
- [ ] Performance regression detection
- [ ] Historical data queries
- [ ] Trend analysis

### Phase 4: Visual Testing (Weeks 7-8)
- [ ] Screenshot capture
- [ ] Pixel diff comparison
- [ ] SSIM comparison
- [ ] Baseline management
- [ ] Diff visualization

### Phase 5: Dashboard (Weeks 9-10)
- [ ] HTML dashboard structure
- [ ] Overview page with charts
- [ ] Test detail pages
- [ ] Visual diff viewer
- [ ] Export functionality

### Phase 6: Polish (Weeks 11-12)
- [ ] Documentation
- [ ] Examples and tutorials
- [ ] Performance optimization
- [ ] Bug fixes
- [ ] Beta testing

## Testing Strategy

### Unit Tests
- Core modules: >90% coverage
- Storage layer: Contract tests
- Analytics: Algorithm validation
- Visual: Comparison accuracy tests

### Integration Tests
- End-to-end test execution
- Multi-framework scenarios
- Storage persistence
- Reporter output validation

### Performance Tests
- Large test suite execution (1000+ tests)
- Storage operations benchmarks
- Analytics computation speed
- Memory usage profiling

### Dogfooding
- Use testfn to test testfn
- Run on super-functions monorepo
- CI/CD integration testing

## Documentation

### User Guides
- Getting Started
- Framework Integration
- Storage Configuration
- Visual Testing Guide
- Dashboard Usage
- CI/CD Integration

### API Reference
- Complete TypeScript API docs
- Configuration options
- Extension points
- Adapter development

### Examples
- Basic Vitest setup
- Playwright E2E testing
- Visual regression testing
- Custom reporters
- Analytics queries

## Open Questions

1. **Artifact Storage**: Should we implement CDN/S3 storage for artifacts?
2. **Distributed Execution**: Support for running tests across multiple machines?
3. **Real-time Collaboration**: Multiple users viewing same test run?
4. **Test Prioritization**: ML-based test ordering to fail fast?
5. **Code Coverage**: Direct integration vs. external tools?

## Success Metrics

**Adoption**:
- 100+ GitHub stars in first month
- 10+ community examples/tutorials
- 5+ production deployments

**Performance**:
- <1s overhead per test run
- 10x faster than baseline test execution
- <100MB storage for 1000 test runs

**Quality**:
- <5 critical bugs in first 3 months
- >95% test pass rate on testfn itself
- <24hr response time on issues

## Future Roadmap (Post-V0)

### V1 Features
- Load testing integration
- API testing support
- Mobile device testing
- Real-time collaboration
- Advanced analytics (ML-based)
- Plugin system

### V2 Features
- Distributed test execution
- Cloud artifact storage
- Team management
- Test impact analysis
- Chaos engineering integration

## Contributors

Initial implementation by 21n team as part of super-functions ecosystem.

## License

MIT License - See LICENSE file for details
