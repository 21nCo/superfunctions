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
  const snapshot: Record<string, string> = Object.create(null);
  for (const name of names) {
    let value: string | null | undefined;
    try { value = await secrets?.getSecret(name); }
    catch { throw new Error('Required pipeline secret is unavailable'); }
    if (typeof value !== 'string') throw new Error('Required pipeline secret is unavailable');
    snapshot[name] = value;
  }
  const payload = input.trigger.payload?.github as { ref?: string; repository?: string; sha?: string } | undefined;
  const context = { secrets: { getSecret: async (name: string) => { if (!Object.prototype.hasOwnProperty.call(snapshot, name)) throw new Error('Required pipeline secret is unavailable'); return snapshot[name]; }, setSecret: async () => {}, listKeys: async () => names }, github: github ?? {
    ref: payload?.ref ?? input.pipelineRef?.ref ?? '', repository: payload?.repository ?? input.pipelineRef?.repo ?? '',
    sha: payload?.sha ?? '', event_name: input.trigger.type,
  } };
  const result: PreparedRun = { input, jobs: [], secretValues: Object.values(snapshot) };
  for (const [jobKey, jobSpec] of Object.entries(spec.jobs)) {
    const { resolved, secretValues } = await resolveEnvMap({ ...spec.env, ...jobSpec.env }, context);
    result.secretValues.push(...secretValues);
    const jobNames = Array.from(discoverSecrets({ on: spec.on, env: spec.env, jobs: { [jobKey]: jobSpec } }));
    result.jobs.push({ jobKey, jobSpec, pipelineRef: input.pipelineRef, env: resolved, secretKeys: jobNames,
      secretSnapshot: Object.fromEntries(jobNames.map(name => [name, snapshot[name]])) });
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
    if (roots.has(job.jobKey)) await queue.enqueue(DEFAULT_QUEUE_NAME, { ...job, runId: run.id, trigger: prepared.input.trigger });
  }
  return run;
}
