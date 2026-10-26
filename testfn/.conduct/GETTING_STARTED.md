# Getting Started with TestFn

TestFn is a comprehensive self-hosted testing platform that combines test execution, analytics, and visual testing.

## Installation

```bash
npm install testfn
```

## Quick Start (5 minutes)

### 1. Basic Test Execution

Create a file `run-tests.ts`:

```typescript
import { testFn } from 'testfn';

const runner = testFn({
  framework: 'vitest',
  testPattern: './tests/**/*.test.ts'
});

await runner.run();
```

Run it:
```bash
npx tsx run-tests.ts
```

### 2. Add Storage for History

```typescript
import { testFn } from 'testfn';

const runner = testFn({
  framework: 'vitest',
  testPattern: './tests/**/*.test.ts',
  storage: {
    type: 'indexeddb',
    dbName: 'my-tests',
    retentionDays: 30
  }
});

await runner.run();
```

### 3. Add Analytics

```typescript
import { testFn, TestStorage, AnalyticsEngine } from 'testfn';

const runner = testFn({
  framework: 'vitest',
  testPattern: './tests/**/*.test.ts',
  storage: {
    type: 'indexeddb',
    dbName: 'my-tests'
  }
});

const results = await runner.run();

const storage = new TestStorage({ type: 'indexeddb', dbName: 'my-tests' });
await storage.open();

const analytics = new AnalyticsEngine(storage);
const metrics = await analytics.computeMetrics(results.id);

console.log('Success Rate:', (metrics.successRate * 100).toFixed(2) + '%');
console.log('Avg Duration:', metrics.avgDuration.toFixed(0) + 'ms');

await storage.close();
```

## Framework Support

### Vitest

```typescript
testFn({
  framework: 'vitest',
  testPattern: './tests/**/*.test.ts',
  parallel: 4
});
```

### Playwright (Multi-Browser)

```typescript
testFn({
  framework: 'playwright',
  testPattern: './e2e/**/*.spec.ts',
  browsers: [
    { name: 'chromium', headless: true },
    { name: 'firefox', headless: true },
    { name: 'webkit', headless: true }
  ]
});
```

## Features

### 📊 Analytics

Automatically track:
- Success rates
- Duration metrics (P50, P95, P99)
- Failure categorization
- Performance trends

```typescript
const metrics = await analytics.computeMetrics(runId);
const flaky = await analytics.detectFlaky(testId, windowSize);
const regressions = await analytics.findRegressions(baselineId, currentId);
```

### 🔍 Flaky Test Detection

```typescript
const analysis = await analytics.detectFlaky('test-id', 10);

if (analysis.flakyScore > 0.7) {
  console.log('⚠️ Quarantine this test!');
} else if (analysis.flakyScore > 0.4) {
  console.log('🔍 Investigate this test');
}
```

### 📈 Performance Regression Detection

```typescript
const regressions = await analytics.findRegressions(
  baselineRunId,
  currentRunId
);

for (const reg of regressions) {
  if (reg.significant) {
    console.log(`⚠️ ${reg.testId}: +${(reg.change * 100).toFixed(0)}%`);
  }
}
```

### 🎨 Visual Testing

```typescript
import { VisualTester } from 'testfn';

const visualTester = new VisualTester({
  baselineDir: './baselines',
  diffDir: './diffs',
  threshold: 0.1
});

const screenshot = await visualTester.captureScreenshot('homepage', buffer);
const result = await visualTester.compareScreenshot(screenshot, 'homepage');

if (!result.passed) {
  console.log(`Visual diff: ${result.diffPercentage}% different`);
}
```

### 📝 Reporters

#### Console Reporter (Default)

```typescript
import { ConsoleReporter } from 'testfn';

testFn({
  framework: 'vitest',
  reporters: [new ConsoleReporter()]
});
```

#### JSON Reporter

```typescript
import { JsonReporter } from 'testfn';

testFn({
  framework: 'vitest',
  reporters: [
    new ConsoleReporter(),
    new JsonReporter('./test-results.json')
  ]
});
```

## Configuration Reference

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

## Examples

Check the `examples/` directory for:
- `basic-usage.ts` - Simple test execution
- `analytics-example.ts` - Analytics and flaky detection
- `multi-browser-example.ts` - Cross-browser testing
- `comprehensive-example.ts` - All features combined

## Best Practices

### 1. Store Results for Analytics
Always enable storage to get historical data and analytics:

```typescript
storage: {
  type: 'indexeddb',
  dbName: 'project-tests',
  retentionDays: 30
}
```

### 2. Monitor Flaky Tests
Run flaky detection regularly:

```typescript
for (const testId of allTestIds) {
  const analysis = await analytics.detectFlaky(testId, 10);
  if (analysis.recommendation === 'quarantine') {
    // Skip or isolate this test
  }
}
```

### 3. Track Performance
Compare runs to catch regressions:

```typescript
const recent = await storage.getRecentRuns(2);
if (recent.length >= 2) {
  const regressions = await analytics.findRegressions(
    recent[1].id,
    recent[0].id
  );
}
```

### 4. Use Multiple Reporters
Combine console output with machine-readable formats:

```typescript
reporters: [
  new ConsoleReporter(),
  new JsonReporter('./results.json')
]
```

## Troubleshooting

### Tests Not Found
Check your test pattern:
```typescript
testPattern: './tests/**/*.{test,spec}.{ts,js}'
```

### Storage Issues
Ensure the database can be created:
```typescript
storage: {
  type: 'indexeddb',
  dbName: 'testfn-unique-name'
}
```

### Framework Not Supported
Currently supported:
- ✅ Vitest
- ✅ Playwright
- 🚧 Jest (coming soon)
- 🚧 Puppeteer (coming soon)

## Next Steps

1. Check [SPEC.md](./ts-sdk/SPEC.md) for detailed architecture
2. Explore [examples/](./ts-sdk/examples/) for more patterns
3. Read the [README.md](./ts-sdk/README.md) for API reference

## Support

- GitHub Issues: https://github.com/21nCo/super-functions/issues
- Documentation: See README.md and SPEC.md

Happy Testing! 🚀
