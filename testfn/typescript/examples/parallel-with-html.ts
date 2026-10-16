import { testFn, HtmlReporter, JsonReporter, ConsoleReporter } from '../src/index.js';

async function main() {
  console.log('🚀 TestFn - Parallel Execution with HTML Dashboard\n');

  const runner = testFn({
    framework: 'vitest',
    testPattern: './tests/**/*.{test,spec}.ts',
    parallel: 'auto',
    retries: 2,
    timeout: 30000,
    storage: {
      type: 'indexeddb',
      dbName: 'testfn-parallel',
      retentionDays: 30
    },
    reporters: [
      new ConsoleReporter(),
      new HtmlReporter('./test-report.html'),
      new JsonReporter('./test-results.json')
    ],
    onProgress: (progress) => {
      if (progress.completed % 10 === 0) {
        console.log(`⚡ Progress: ${progress.completed}/${progress.total} tests`);
      }
    },
    onComplete: (results) => {
      console.log('\n✨ Test Execution Complete!\n');
      console.log('📊 Results:');
      console.log(`   Total: ${results.summary.total}`);
      console.log(`   Passed: ${results.summary.passed}`);
      console.log(`   Failed: ${results.summary.failed}`);
      console.log(`   Duration: ${(results.summary.duration / 1000).toFixed(2)}s`);
      console.log('\n📁 Reports Generated:');
      console.log('   - HTML: ./test-report.html');
      console.log('   - JSON: ./test-results.json');
    }
  });

  try {
    const results = await runner.run();

    console.log('\n✅ Test run completed successfully');
    console.log('💡 Open test-report.html in your browser to view the dashboard');

    process.exit(results.summary.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('\n❌ Test execution failed:', error);
    process.exit(1);
  }
}

main();
