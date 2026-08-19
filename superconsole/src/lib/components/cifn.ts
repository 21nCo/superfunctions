import { ADMIN_API_PREFIX, withAdminScope } from './admin-api';
import { isAdminRecord } from './view-models';

export interface NormalizedCiStep {
  id: string;
  stepKey: string;
  status: string;
  completedAt?: string;
}

export interface NormalizedCiJob {
  id: string;
  jobKey: string;
  status: string;
  steps: NormalizedCiStep[];
  startedAt?: string;
}

export interface NormalizedCiRun {
  runId: string;
  pipelineRef: { repo: string; ref: string; configPath?: string };
  trigger: { type: string };
  status: string;
  createdAt?: string;
  updatedAt?: string;
  jobs: NormalizedCiJob[];
}

function displayString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Normalize function-owned run records before the specialized dashboard dereferences them. */
export function normalizeCiRun(value: unknown, fallbackRunId: string): NormalizedCiRun | undefined {
  if (!isAdminRecord(value)) return undefined;
  const pipeline = isAdminRecord(value.pipelineRef) ? value.pipelineRef : {};
  const trigger = isAdminRecord(value.trigger) ? value.trigger : {};
  const rawJobs = Array.isArray(value.jobs) ? value.jobs : [];
  const jobs = rawJobs.flatMap((candidate, jobIndex): NormalizedCiJob[] => {
    if (!isAdminRecord(candidate)) return [];
    const jobKey = displayString(candidate.jobKey, displayString(candidate.name, `Job ${jobIndex + 1}`));
    const rawSteps = Array.isArray(candidate.steps) ? candidate.steps : [];
    const steps = rawSteps.flatMap((step, stepIndex): NormalizedCiStep[] => {
      if (!isAdminRecord(step)) return [];
      const stepKey = displayString(step.stepKey, displayString(step.name, `Step ${stepIndex + 1}`));
      return [{
        id: displayString(step.id, `${jobKey}:step:${stepIndex + 1}`),
        stepKey,
        status: displayString(step.status, 'unknown'),
        completedAt: optionalString(step.completedAt),
      }];
    });
    return [{
      id: displayString(candidate.id, `${fallbackRunId}:job:${jobIndex + 1}`),
      jobKey,
      status: displayString(candidate.status, 'unknown'),
      steps,
      startedAt: optionalString(candidate.startedAt),
    }];
  });

  return {
    runId: displayString(value.runId, fallbackRunId),
    pipelineRef: {
      repo: displayString(pipeline.repo, 'Repository unavailable'),
      ref: displayString(pipeline.ref, 'Ref unavailable'),
      configPath: optionalString(pipeline.configPath),
    },
    trigger: { type: displayString(trigger.type, 'Trigger unavailable') },
    status: displayString(value.status, 'unknown'),
    createdAt: optionalString(value.createdAt),
    updatedAt: optionalString(value.updatedAt),
    jobs,
  };
}

/** Translate console-only run filters into CiFn's canonical list operation input. */
export function ciRunListAdminHref(searchParams: URLSearchParams): string {
  const transport = new URLSearchParams();
  transport.set('limit', searchParams.get('limit') ?? '50');
  const cursor = searchParams.get('cursor');
  if (cursor) transport.set('cursor', cursor);
  const status = searchParams.get('status');
  if (status) transport.set('filter', JSON.stringify({ status }));
  return withAdminScope(
    `${ADMIN_API_PREFIX}/modules/cifn/runs?${transport}`,
    searchParams
  );
}
