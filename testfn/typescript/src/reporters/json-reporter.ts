import { writeFileSync } from 'fs';
import type { TestRunSummary, Reporter, JsonReport } from '../types.js';

export class JsonReporter implements Reporter {
  private outputPath: string;
  private runData: Partial<JsonReport> = {};

  constructor(outputPath: string = './testfn-results.json') {
    this.outputPath = outputPath;
  }

  onRunComplete(summary: TestRunSummary): void {
    const report: JsonReport = {
      version: '0.1.0',
      timestamp: Date.now(),
      summary,
      results: [],
      artifacts: [],
      metadata: {
        ...this.runData.metadata
      }
    };

    const json = JSON.stringify(report, null, 2);
    
    try {
      writeFileSync(this.outputPath, json, 'utf-8');
      console.log(`\nJSON report written to ${this.outputPath}`);
    } catch (error) {
      console.error('Failed to write JSON report:', error);
    }
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this.runData.metadata = { ...this.runData.metadata, ...metadata };
  }
}
