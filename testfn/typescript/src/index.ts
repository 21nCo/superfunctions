import { TestRunner } from './core/test-runner.js';
import type { TestFnConfig } from './types.js';

export { TestStorage } from './storage/test-storage.js';
export { IndexedDbManager } from './storage/indexeddb-manager.js';

export { ConsoleReporter } from './reporters/console-reporter.js';
export { JsonReporter } from './reporters/json-reporter.js';
export { HtmlReporter } from './reporters/html-reporter.js';

export { TestRunner } from './core/test-runner.js';
export { WorkerPool } from './core/worker-pool.js';

export { VitestAdapter, PlaywrightAdapter, JestAdapter, BaseAdapter } from './integrations/index.js';
export { AnalyticsEngine } from './analytics/index.js';
export { VisualTester } from './visual/index.js';

export * from './types.js';

export function testFn(config: TestFnConfig): TestRunner {
  return new TestRunner(config);
}

export default testFn;
