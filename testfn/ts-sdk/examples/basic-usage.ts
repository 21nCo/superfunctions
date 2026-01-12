import { testFn } from '../src/index.js';

async function main() {
  const runner = testFn({
    framework: 'vitest',
    testPattern: './tests/**/*.test.ts',
    parallel: 4,
    storage: {
      type: 'indexeddb',
      dbName: 'testfn-example',
      retentionDays: 30
    },
    onProgress: (progress) => {
      console.log(`Progress: ${progress.completed}/${progress.total}`);
    },
    onComplete: (results) => {
      console.log(`\nTest run complete!`);
      console.log(`Run ID: ${results.id}`);
      console.log(`Total: ${results.summary.total}`);
      console.log(`Passed: ${results.summary.passed}`);
      console.log(`Failed: ${results.summary.failed}`);
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
