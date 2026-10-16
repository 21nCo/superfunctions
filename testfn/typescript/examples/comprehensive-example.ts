import {
  testFn,
  TestStorage,
  AnalyticsEngine,
  ConsoleReporter,
  JsonReporter
} from '../src/index.js';

async function runWithAnalytics() {
  console.log('='.repeat(60));
  console.log('TestFn Comprehensive Example');
  console.log('='.repeat(60));

  const runner = testFn({
    framework: 'vitest',
    testPattern: './tests/**/*.{test,spec}.ts',
    parallel: 4,
    timeout: 30000,
    retries: 2,
    storage: {
      type: 'indexeddb',
      dbName: 'testfn-comprehensive',
      retentionDays: 30
    },
    reporters: [
      new ConsoleReporter(),
      new JsonReporter('./testfn-results.json')
    ],
    onProgress: (progress) => {
      if (progress.completed % 5 === 0) {
        const pct = Math.floor((progress.completed / progress.total) * 100);
        console.log(`Progress: ${pct}% (${progress.completed}/${progress.total})`);
      }
    }
  });

  const results = await runner.run();

  const storage = new TestStorage({
    type: 'indexeddb',
    dbName: 'testfn-comprehensive'
  });

  await storage.open();

  const analytics = new AnalyticsEngine(storage);

  console.log('\n' + '='.repeat(60));
  console.log('Analytics Report');
  console.log('='.repeat(60));

  const metrics = await analytics.computeMetrics(results.id);

  console.log('\n📊 Performance Metrics:');
  console.log(`   Success Rate: ${(metrics.successRate * 100).toFixed(2)}%`);
  console.log(`   Avg Duration: ${metrics.avgDuration.toFixed(0)}ms`);
  console.log(`   P50: ${metrics.p50Duration}ms | P95: ${metrics.p95Duration}ms | P99: ${metrics.p99Duration}ms`);

  if (Object.keys(metrics.failuresByType).length > 0) {
    console.log('\n❌ Failures by Type:');
    for (const [type, count] of Object.entries(metrics.failuresByType)) {
      console.log(`   ${type}: ${count}`);
    }
  }

  console.log('\n🔍 Flaky Test Analysis:');
  let flakyCount = 0;

  for (const result of results.results) {
    const flaky = await analytics.detectFlaky(result.id, 10);

    if (flaky.flakyScore > 0.3) {
      flakyCount++;
      const emoji = flaky.recommendation === 'quarantine' ? '🚨' :
                    flaky.recommendation === 'investigate' ? '⚠️' : '✅';

      console.log(`   ${emoji} ${result.id}`);
      console.log(`      Score: ${flaky.flakyScore.toFixed(2)} | Pass Rate: ${(flaky.passRate * 100).toFixed(0)}%`);
      console.log(`      Action: ${flaky.recommendation}`);
    }
  }

  if (flakyCount === 0) {
    console.log('   ✅ No flaky tests detected');
  }

  const recentRuns = await storage.getRecentRuns(5);

  if (recentRuns.length >= 2) {
    console.log('\n📈 Performance Regression Analysis:');
    const regressions = await analytics.findRegressions(
      recentRuns[1].id,
      recentRuns[0].id
    );

    if (regressions.length > 0) {
      for (const reg of regressions) {
        const changeEmoji = reg.significant ? '🔴' : '🟡';
        console.log(`   ${changeEmoji} ${reg.testId}`);
        console.log(`      Baseline: ${reg.baseline}ms → Current: ${reg.current}ms`);
        console.log(`      Change: +${(reg.change * 100).toFixed(0)}%`);
      }
    } else {
      console.log('   ✅ No performance regressions detected');
    }
  }

  console.log('\n📊 Historical Data:');
  console.log(`   Total runs stored: ${recentRuns.length}`);
  console.log(`   Oldest run: ${new Date(recentRuns[recentRuns.length - 1]?.timestamp).toLocaleString()}`);
  console.log(`   Latest run: ${new Date(recentRuns[0]?.timestamp).toLocaleString()}`);

  await storage.close();

  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`✓ Tests executed: ${results.summary.total}`);
  console.log(`✓ Results stored in IndexedDB`);
  console.log(`✓ JSON report: ./testfn-results.json`);
  console.log(`✓ Analytics computed and displayed`);
  console.log('='.repeat(60) + '\n');

  return results.summary.failed === 0;
}

runWithAnalytics()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => {
    console.error('\n❌ Error:', error);
    process.exit(1);
  });
