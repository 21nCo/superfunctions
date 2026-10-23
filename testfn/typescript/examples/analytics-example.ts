import { testFn, TestStorage, AnalyticsEngine } from '../src/index.js';

async function main() {
  const runner = testFn({
    framework: 'vitest',
    testPattern: './tests/**/*.test.ts',
    storage: {
      type: 'indexeddb',
      dbName: 'testfn-analytics',
      retentionDays: 30
    }
  });

  console.log('Running tests...\n');
  const results = await runner.run();

  const storage = new TestStorage({
    type: 'indexeddb',
    dbName: 'testfn-analytics'
  });

  await storage.open();

  const analytics = new AnalyticsEngine(storage);

  console.log('\n=== Analytics ===\n');

  const metrics = await analytics.computeMetrics(results.id);
  console.log('Run Metrics:');
  console.log(`  Success Rate: ${(metrics.successRate * 100).toFixed(2)}%`);
  console.log(`  Avg Duration: ${metrics.avgDuration.toFixed(0)}ms`);
  console.log(`  P50 Duration: ${metrics.p50Duration.toFixed(0)}ms`);
  console.log(`  P95 Duration: ${metrics.p95Duration.toFixed(0)}ms`);
  console.log(`  P99 Duration: ${metrics.p99Duration.toFixed(0)}ms`);
  
  if (Object.keys(metrics.failuresByType).length > 0) {
    console.log('\n  Failures by Type:');
    for (const [type, count] of Object.entries(metrics.failuresByType)) {
      console.log(`    ${type}: ${count}`);
    }
  }

  console.log('\n=== Flaky Test Detection ===\n');
  
  for (const result of results.results) {
    const flakyAnalysis = await analytics.detectFlaky(result.id, 10);
    
    if (flakyAnalysis.flakyScore > 0.4) {
      console.log(`Test: ${result.id}`);
      console.log(`  Flaky Score: ${flakyAnalysis.flakyScore.toFixed(2)}`);
      console.log(`  Pass Rate: ${(flakyAnalysis.passRate * 100).toFixed(0)}%`);
      console.log(`  Recommendation: ${flakyAnalysis.recommendation}`);
      console.log('');
    }
  }

  const recentRuns = await storage.getRecentRuns(5);
  console.log(`\nTotal runs in storage: ${recentRuns.length}`);

  await storage.close();
}

main().catch(console.error);
