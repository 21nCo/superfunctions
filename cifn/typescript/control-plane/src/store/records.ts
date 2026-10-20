import { v4 as uuidv4 } from 'uuid';
import type { Run, Job, Step } from '../pipeline/types.js';
import type { CreateRunInput } from './memory-store.js';

export function createRunRecord(input: CreateRunInput): Run {
    const runId = uuidv4();
    const now = new Date().toISOString();

    const jobs: Job[] = Object.entries(input.pipelineSpec.jobs).map(([jobKey, jobSpec]) => {
      const jobId = uuidv4();
      const steps: Step[] = jobSpec.steps.map((stepSpec, index) => ({
        id: uuidv4(),
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
