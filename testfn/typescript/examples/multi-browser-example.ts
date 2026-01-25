import { testFn, JsonReporter, ConsoleReporter } from '../src/index.js';

async function main() {
  const runner = testFn({
    framework: 'playwright',
    testPattern: './e2e/**/*.spec.ts',
    browsers: [
      { name: 'chromium', headless: true },
      { name: 'firefox', headless: true },
      { name: 'webkit', headless: true }
    ],
    parallel: 3,
    timeout: 30000,
    storage: {
      type: 'indexeddb',
      dbName: 'testfn-multi-browser',
      retentionDays: 30
    },
    reporters: [
      new ConsoleReporter(),
      new JsonReporter('./test-results.json')
    ],
    onProgress: (progress) => {
      const percentage = Math.floor((progress.completed / progress.total) * 100);
      if (progress.current) {
        console.log(`[${percentage}%] Running: ${progress.current.name}`);
      }
    },
    onComplete: (results) => {
      console.log('\n=== Cross-Browser Summary ===');
      console.log(`Total tests: ${results.summary.total}`);
      console.log(`Passed: ${results.summary.passed}`);
      console.log(`Failed: ${results.summary.failed}`);
      console.log(`Duration: ${(results.summary.duration / 1000).toFixed(2)}s`);
      
      const byBrowser = new Map<string, { passed: number; failed: number }>();
      
      for (const result of results.results) {
        const browser = result.metadata?.browser as string || 'unknown';
        const stats = byBrowser.get(browser) || { passed: 0, failed: 0 };
        
        if (result.status === 'passed') {
          stats.passed++;
        } else if (result.status === 'failed') {
          stats.failed++;
        }
        
        byBrowser.set(browser, stats);
      }
      
      console.log('\nResults by browser:');
      for (const [browser, stats] of byBrowser.entries()) {
        const total = stats.passed + stats.failed;
        const passRate = total > 0 ? (stats.passed / total * 100).toFixed(0) : '0';
        console.log(`  ${browser}: ${stats.passed}/${total} passed (${passRate}%)`);
      }
    }
  });

  try {
    const results = await runner.run();
    process.exit(results.summary.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('Test execution failed:', error);
    process.exit(1);
  }
}

main();
