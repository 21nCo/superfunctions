import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  TestResult,
  TestRunSummary,
  Reporter,
  JsonReport,
} from "../types.js";

export class JsonReporter implements Reporter {
  private results: TestResult[] = [];
  private metadata: Record<string, unknown> = {};
  constructor(private outputPath = "./testfn-results.json") {}
  onRunStart(): void {
    this.results = [];
  }
  onTestComplete(result: TestResult): void {
    this.results.push(result);
  }
  onRunComplete(summary: TestRunSummary): void {
    const report: JsonReport = {
      version: "0.1.0",
      timestamp: Date.now(),
      summary,
      results: this.results,
      artifacts: this.results.flatMap((result) =>
        (result.artifacts ?? []).map((artifact, index) => ({
          id: `${result.id}-${artifact.type}-${index}`,
          testId: result.id,
          type: artifact.type,
          path: artifact.path,
        })),
      ),
      metadata: this.metadata,
    };
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(this.outputPath, JSON.stringify(report, null, 2), "utf8");
  }
  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = { ...this.metadata, ...metadata };
  }
}
