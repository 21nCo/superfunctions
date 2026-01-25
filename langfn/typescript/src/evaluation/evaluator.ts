import { LangFn } from "../client.js";

export interface EvaluationDatasetItem {
  input: string;
  expected: string;
  metadata?: Record<string, any>;
}

export interface EvaluationMetric {
  name: string;
  fn: (output: string, expected: string) => boolean | number;
}

export interface EvaluationResult {
  accuracy: number;
  avgLatency: number;
  totalCost: number;
  results: Array<{
    input: string;
    output: string;
    expected: string;
    passed: boolean;
    score: number;
    latency: number;
  }>;
}

export class Evaluator {
  private metrics: EvaluationMetric[] = [
    {
      name: "exact_match",
      fn: (output, expected) => output.trim() === expected.trim()
    },
    {
      name: "contains",
      fn: (output, expected) => output.includes(expected)
    }
  ];

  async evaluate(options: {
    lang: LangFn;
    dataset: EvaluationDatasetItem[];
    metrics?: string[];
  }): Promise<EvaluationResult> {
    const results: any[] = [];
    let totalScore = 0;
    let totalLatency = 0;

    for (const item of options.dataset) {
      const startTime = Date.now();
      const response = await options.lang.complete(item.input);
      const latency = Date.now() - startTime;

      const output = response.content;
      const passed = output.trim() === item.expected.trim();
      const score = passed ? 1 : 0;

      totalScore += score;
      totalLatency += latency;

      results.push({
        input: item.input,
        output,
        expected: item.expected,
        passed,
        score,
        latency
      });
    }

    return {
      accuracy: totalScore / options.dataset.length,
      avgLatency: totalLatency / options.dataset.length,
      totalCost: 0, // Cost calculation needs usage integration
      results
    };
  }

  async compare(options: {
    models: Array<{ name: string; lang: LangFn }>;
    dataset: EvaluationDatasetItem[];
  }): Promise<Record<string, EvaluationResult>> {
    const comparisons: Record<string, EvaluationResult> = {};
    for (const model of options.models) {
      comparisons[model.name] = await this.evaluate({
        lang: model.lang,
        dataset: options.dataset
      });
    }
    return comparisons;
  }
}
