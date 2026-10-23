export type TestStatus = 'passed' | 'failed' | 'skipped' | 'timeout';
export type FrameworkType = 'vitest' | 'playwright' | 'jest' | 'puppeteer';
export type StorageType = 'indexeddb' | 'file' | 'db';
export type BrowserType = 'chromium' | 'firefox' | 'webkit';
export type ArtifactType = 'screenshot' | 'video' | 'trace' | 'log';

export interface TestFnConfig {
  framework: FrameworkType;
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

export interface StorageConfig {
  type: StorageType;
  dbName?: string;
  adapter?: unknown;
  retentionDays?: number;
}

export interface BrowserConfig {
  name: BrowserType;
  headless?: boolean;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  permissions?: string[];
  geolocation?: { latitude: number; longitude: number };
}

export interface VisualTestConfig {
  baselineDir: string;
  diffDir: string;
  threshold?: number;
  updateBaselines?: boolean;
  fullPage?: boolean;
}

export interface TestCase {
  id: string;
  file: string;
  name: string;
  suite?: string;
  tags?: string[];
}

export interface TestResult {
  id: string;
  status: TestStatus;
  duration: number;
  error?: TestError;
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface TestError {
  message: string;
  stack?: string;
  expected?: unknown;
  actual?: unknown;
  diff?: string;
}

export interface Artifact {
  type: ArtifactType;
  path: string;
  buffer?: Buffer;
  metadata?: Record<string, unknown>;
}

export interface TestProgress {
  completed: number;
  total: number;
  current?: TestCase;
}

export interface TestResults {
  id: string;
  timestamp: number;
  summary: TestRunSummary;
  results: TestResult[];
  artifacts?: ArtifactReference[];
}

export interface TestRunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  coverage?: CoverageData;
}

export interface CoverageData {
  lines: number;
  statements: number;
  functions: number;
  branches: number;
}

export interface ArtifactReference {
  id: string;
  testId: string;
  type: ArtifactType;
  path: string;
}

export interface TestRun {
  id: string;
  timestamp: number;
  branch?: string;
  commit?: string;
  author?: string;
  environment: EnvironmentInfo;
  summary: TestRunSummary;
  results: TestResult[];
}

export interface EnvironmentInfo {
  platform: string;
  nodeVersion?: string;
  browser?: BrowserInfo;
  ci?: boolean;
}

export interface BrowserInfo {
  name: string;
  version: string;
  headless: boolean;
}

export interface TestFrameworkAdapter {
  name: string;
  discover(pattern: string[]): Promise<TestCase[]>;
  run(tests: TestCase[], options: RunOptions): Promise<TestResult[]>;
  supports(framework: string): boolean;
}

export interface RunOptions {
  parallel?: number;
  timeout?: number;
  retries?: number;
  env?: Record<string, string>;
  browsers?: BrowserConfig[];
  onProgress?: (progress: TestProgress) => void;
}

export interface Reporter {
  onTestStart?(test: TestCase): void;
  onTestComplete?(result: TestResult): void;
  onRunComplete?(summary: TestRunSummary): void;
}

export interface RunMetrics {
  successRate: number;
  avgDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  failuresByType: Record<string, number>;
}

export interface FlakyAnalysis {
  testId: string;
  flakyScore: number;
  passRate: number;
  recentResults: boolean[];
  recommendation: 'investigate' | 'quarantine' | 'stable';
}

export interface Regression {
  testId: string;
  metric: 'duration' | 'memory' | 'coverage';
  baseline: number;
  current: number;
  change: number;
  significant: boolean;
}

export interface TrendData {
  testId: string;
  dataPoints: Array<{
    timestamp: number;
    value: number;
    status: string;
  }>;
}

export interface Screenshot {
  name: string;
  buffer: Buffer;
  width: number;
  height: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ComparisonResult {
  passed: boolean;
  similarity: number;
  pixelDiffCount: number;
  diffPercentage: number;
  diffImage?: Buffer;
  regions?: DiffRegion[];
}

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  severity: 'minor' | 'major';
}

export interface JsonReport {
  version: string;
  timestamp: number;
  summary: TestRunSummary;
  results: TestResult[];
  artifacts: ArtifactReference[];
  metadata: Record<string, unknown>;
}

export interface NetworkProfile {
  name: string;
  downloadThroughput: number;
  uploadThroughput: number;
  latency: number;
}

export interface DeviceProfile {
  name: string;
  userAgent: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}
