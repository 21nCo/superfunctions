import { randomUUID } from 'node:crypto';
import type { Run, Job, Step } from '../pipeline/types.js';
import type { CreateRunInput } from './memory-store.js';

export function createRunRecord(input: CreateRunInput): Run {
    const runId = randomUUID();
    const now = new Date().toISOString();

    const jobs: Job[] = Object.entries(input.pipelineSpec.jobs).map(([jobKey, jobSpec]) => {
      const jobId = randomUUID();
      const steps: Step[] = jobSpec.steps.map((stepSpec, index) => ({
        id: randomUUID(),
        jobId,
        stepKey: `step-${index}`,
        status: 'pending' as const,
      }));
      return {
        id: jobId,
        runId,
        jobKey,
        status: 'pending' as const,
        steps,
      };
    });

    const run: Run = {
      id: runId,
      pipelineRef: input.pipelineRef ?? { repo: '', ref: '' },
      trigger: input.trigger,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      jobs,
    };

    return run;
}
