import type { CreateRunInput } from '../store/memory-store.js';
import type { ControlPlaneStore } from '../store/store.js';
import type { QueueClient } from '../queue/flowfn-client.js';
import { DEFAULT_QUEUE_NAME } from '../queue/flowfn-client.js';
import type { SecFnClient } from '../secrets/secfn-client.js';
import { discoverSecrets } from '../secrets/discover.js';
import { resolveEnvMap } from '../secrets/expression.js';
import { resolveDAG } from '../pipeline/dag.js';
import { isDispatchStore, type PreparedRun } from './types.js';
import { publishRun } from './publisher.js';

/** Resolve every environment before writing an accepted run or dispatch intent. */
export async function prepareRun(input: CreateRunInput, secrets?: SecFnClient, github?: { ref: string; repository: string; sha: string; event_name: string }): Promise<PreparedRun> {
  input = JSON.parse(JSON.stringify(input)) as CreateRunInput;
  const spec = input.pipelineSpec;
  resolveDAG(spec);
  const names = Array.from(discoverSecrets(spec));
  const payload = input.trigger.payload?.github as { ref?: string; repository?: string; sha?: string } | undefined;
  const context = { secrets: secrets ?? { getSecret: async () => { throw new Error('Secret provider is not configured'); }, setSecret: async () => {}, listKeys: async () => [] }, github: github ?? {
    ref: payload?.ref ?? input.pipelineRef?.ref ?? '', repository: payload?.repository ?? input.pipelineRef?.repo ?? '',
    sha: payload?.sha ?? '', event_name: input.trigger.type,
  } };
  const result: PreparedRun = { input, jobs: [], secretValues: [] };
  for (const [jobKey, jobSpec] of Object.entries(spec.jobs)) {
    const { resolved, secretValues } = await resolveEnvMap({ ...spec.env, ...jobSpec.env }, context);
    result.secretValues.push(...secretValues);
    result.jobs.push({ jobKey, jobSpec, pipelineRef: input.pipelineRef, env: resolved, secretKeys: names });
  }
  result.secretValues = [...new Set(result.secretValues)];
  return result;
}
export async function acceptRun(store: ControlPlaneStore, queue: QueueClient, prepared: PreparedRun) {
  if (isDispatchStore(store)) {
    const run = await store.createPreparedRun(prepared);
    // Publication failure leaves accepted intent available for retry; it does not
    // turn a committed run into an ambiguous client-facing creation failure.
    await publishRun(store, queue, run.id).catch(() => console.error('CiFn dispatch publication failed; durable retry pending'));
    return run;
  }
  const run = await store.createRun(prepared.input);
  const roots = new Set(resolveDAG(prepared.input.pipelineSpec).rootJobs);
  for (const job of prepared.jobs) {
    await store.registerJobSecretValues(run.id, job.jobKey, prepared.secretValues);
    if (roots.has(job.jobKey)) await queue.enqueue(DEFAULT_QUEUE_NAME, { ...job, runId: run.id });
  }
  return run;
}
