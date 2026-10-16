import type { TestStorage } from "../storage/test-storage.js";
import type {
  RunMetrics,
  FlakyAnalysis,
  Regression,
  TrendData,
  TestRun,
  CoverageData,
} from "../types.js";

export class AnalyticsEngine {
  private metricCache = new Map<
    string,
    { fingerprint: string; metrics: RunMetrics }
  >();
  private customMetrics = new Map<string, (run: TestRun) => number>();
  registerMetric(name: string, compute: (run: TestRun) => number): void {
    if (!name.trim()) throw new Error("Metric name must not be empty");
    this.customMetrics.set(name, compute);
  }
  async computeCustomMetrics(runId: string): Promise<Record<string, number>> {
    const run = await this.storage.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    const values: Record<string, number> = Object.create(null);
    for (const [name, compute] of this.customMetrics) {
      const value = compute(run);
      if (!Number.isFinite(value))
        throw new Error(`Metric ${name} must return a finite number`);
      values[name] = value;
    }
    return values;
  }
  async getCoverageTrends(
    days = 30,
  ): Promise<
    Array<{ runId: string; timestamp: number; coverage: CoverageData }>
  > {
    if (!Number.isFinite(days) || days < 0)
      throw new Error("days must be nonnegative");
    const cutoff = Date.now() - days * 86400000;
    return (await this.storage.getRecentRuns(Number.MAX_SAFE_INTEGER))
      .filter((run) => run.timestamp >= cutoff && run.summary.coverage)
      .map((run) => ({
        runId: run.id,
        timestamp: run.timestamp,
        coverage: run.summary.coverage!,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  constructor(private storage: TestStorage) {}

  async computeMetrics(runId: string): Promise<RunMetrics> {
    const run = await this.storage.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const fingerprint = JSON.stringify([
      run.summary,
      run.results.map(({ duration, status, error }) => ({
        duration,
        status,
        error,
      })),
    ]);
    const cached = this.metricCache.get(runId);
    if (cached?.fingerprint === fingerprint)
      return structuredClone(cached.metrics);
    const durations = run.results.map((r) => r.duration).sort((a, b) => a - b);
    const failuresByType: Record<string, number> = {};

    for (const result of run.results) {
      if (result.error) {
        const errorType = this.categorizeError(result.error.message);
        failuresByType[errorType] = (failuresByType[errorType] || 0) + 1;
      }
    }

    const metrics: RunMetrics = {
      successRate: run.summary.total
        ? run.summary.passed / run.summary.total
        : 0,
      avgDuration: durations.length
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0,
      p50Duration: this.percentile(durations, 0.5),
      p95Duration: this.percentile(durations, 0.95),
      p99Duration: this.percentile(durations, 0.99),
      failuresByType,
    };
    this.metricCache.set(runId, { fingerprint, metrics });
    if (this.metricCache.size > 100)
      this.metricCache.delete(this.metricCache.keys().next().value!);
    return structuredClone(metrics);
  }

  async detectFlaky(
    testId: string,
    windowSize: number = 10,
  ): Promise<FlakyAnalysis> {
    const history = (
      await this.storage.getTestHistory(testId, windowSize)
    ).filter((result) => result.status !== "skipped");

    if (history.length === 0) {
      return {
        testId,
        flakyScore: 0,
        passRate: 1,
        recentResults: [],
        recommendation: "stable",
      };
    }

    const recentResults = history.map((r) => r.status === "passed");
    const passRate =
      recentResults.filter(Boolean).length / recentResults.length;

    let flakyScore = 0;
    if (passRate > 0.2 && passRate < 0.8) {
      flakyScore = 1 - Math.abs(passRate - 0.5) * 2;

      const volatility = this.calculateVolatility(recentResults);
      flakyScore = Math.min(flakyScore * (1 + volatility), 1);
    }

    let recommendation: "investigate" | "quarantine" | "stable";
    if (flakyScore > 0.7) {
      recommendation = "quarantine";
    } else if (flakyScore > 0.4) {
      recommendation = "investigate";
    } else {
      recommendation = "stable";
    }

    return {
      testId,
      flakyScore,
      passRate,
      recentResults,
      recommendation,
    };
  }

  async findRegressions(
    baselineRunId: string,
    currentRunId: string,
  ): Promise<Regression[]> {
    const [baselineRun, currentRun] = await Promise.all([
      this.storage.getRun(baselineRunId),
      this.storage.getRun(currentRunId),
    ]);

    if (!baselineRun || !currentRun) {
      throw new Error("Run not found");
    }

    const regressions: Regression[] = [];

    for (const currentTest of currentRun.results) {
      const baselineTest = baselineRun.results.find(
        (t) => t.id === currentTest.id,
      );
      if (!baselineTest || baselineTest.duration <= 0) continue;

      const change =
        (currentTest.duration - baselineTest.duration) / baselineTest.duration;
      const absoluteChange = currentTest.duration - baselineTest.duration;

      if (change > 0.2 && absoluteChange > 100) {
        regressions.push({
          testId: currentTest.id,
          metric: "duration",
          baseline: baselineTest.duration,
          current: currentTest.duration,
          change,
          significant: change > 0.5 || absoluteChange > 1000,
        });
      }
    }

    return regressions;
  }

  async getTrends(testId: string, days: number = 30): Promise<TrendData> {
    const cutoffTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;
    const allRuns = await this.storage.getRecentRuns(Number.MAX_SAFE_INTEGER);

    const relevantRuns = allRuns.filter(
      (run) => run.timestamp >= cutoffTimestamp,
    );
    const dataPoints: TrendData["dataPoints"] = [];

    for (const run of relevantRuns) {
      const test = run.results.find((r) => r.id === testId);
      if (test) {
        dataPoints.push({
          timestamp: run.timestamp,
          value: test.duration,
          status: test.status,
        });
      }
    }

    dataPoints.sort((a, b) => a.timestamp - b.timestamp);

    return {
      testId,
      dataPoints,
    };
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  private categorizeError(message: string): string {
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes("timeout")) return "timeout";
    if (lowerMessage.includes("assertion") || lowerMessage.includes("expect"))
      return "assertion";
    if (lowerMessage.includes("network") || lowerMessage.includes("fetch"))
      return "network";
    if (lowerMessage.includes("element") || lowerMessage.includes("selector"))
      return "selector";
    if (
      lowerMessage.includes("reference") ||
      lowerMessage.includes("undefined")
    )
      return "reference";

    return "other";
  }

  private calculateVolatility(results: boolean[]): number {
    let changes = 0;
    for (let i = 1; i < results.length; i++) {
      if (results[i] !== results[i - 1]) {
        changes++;
      }
    }
    return changes / Math.max(results.length - 1, 1);
  }
}
