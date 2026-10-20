import { randomUUID } from 'node:crypto';
import { MemoryStore, MemoryQueueClient, DEFAULT_QUEUE_NAME, type JobPayload, type JobCompletion, type PipelineSpec } from '@cifn/control-plane';
import { Runner } from './runner.js';
import { MemoryLogFnClient } from './reporting/logfn-client.js';
import { ClaimJournal, type ClaimJournalEntry } from './claim-journal.js';

export interface RemoteRunnerOptions { baseUrl: string; runnerId: string; runnerSecret: string; stateDirectory: string; fetch?: typeof fetch }
interface ResumableClaim { payload?: JobPayload; runId: string; dispatchId: string; claimToken: string; executionId?: string; reconciliationRequired: boolean }

/** Reuses the real shell executor. The memory projection is scratch state only. */
export async function executeRemoteShellJob(payload: JobPayload): Promise<JobCompletion> {
  const failed = (): JobCompletion => ({ status: 'failure', steps: payload.jobSpec.steps.map((_, index) => ({ stepKey: `step-${index}`, status: index === 0 ? 'failure' : 'skipped' })) });
  if (payload.jobSpec.image || payload.jobSpec.steps.some(step => !('run' in step))) {
    console.error('Remote job requires an unsupported executor/provider'); return failed();
  }
  const store = new MemoryStore(); const queue = new MemoryQueueClient();
  // Prepared environments are authoritative snapshots; do not interpolate them twice.
  const jobSpec = { ...payload.jobSpec, needs: [], env: undefined };
  const spec: PipelineSpec = { on: { workflow_dispatch: {} }, jobs: { [payload.jobKey]: jobSpec } };
  const run = store.createRun({ pipelineSpec: spec, pipelineRef: payload.pipelineRef, trigger: { type: (payload.trigger?.type ?? 'workflow_dispatch') as 'workflow_dispatch', payload: payload.trigger?.payload } });
  await queue.enqueue(DEFAULT_QUEUE_NAME, { ...payload, runId: run.id, jobSpec });
  const runner = new Runner({ executionEnv: { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR }, store, queue, logClient: new MemoryLogFnClient(), labels: [jobSpec['runs-on']],
    pipelineSpecs: new Map([[run.id, spec]]), secretValues: new Map([[run.id, Object.values(payload.env ?? {}).filter(Boolean)]]) });
  try { await runner.processNextJob(); } catch { return failed(); }
  const result = store.getRun(run.id)!.jobs[0];
  const status = ['success', 'failure', 'skipped'].includes(result.status) ? result.status as JobCompletion['status'] : 'failure';
  const steps: JobCompletion['steps'] = result.steps.map(step => ({ stepKey: step.stepKey, status: ['success', 'failure', 'skipped'].includes(step.status) ? step.status as JobCompletion['status'] : 'skipped' }));
  if (status === 'failure' && !steps.some(step => step.status === 'failure') && steps[0]) steps[0].status = 'failure';
  return { status, steps };
}

class RunnerProtocolError extends Error { constructor(readonly status: number) { super(`Runner protocol request failed (${status})`); } }

export class RemoteRunner {
  private journal: ClaimJournal;
  private fetcher: typeof fetch;
  private reportedUncertain = new Set<string>();
  constructor(private options: RemoteRunnerOptions) { this.journal = new ClaimJournal(options.stateDirectory); this.fetcher = options.fetch ?? fetch; }
  private async request<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetcher(this.options.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.runnerSecret}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new RunnerProtocolError(response.status);
    const envelope = await response.json() as { ok: boolean; data: T };
    if (!envelope.ok) throw new Error('Runner protocol request failed');
    return envelope.data;
  }
  private async finish(entry: ClaimJournalEntry): Promise<void> {
    try {
      await this.request('/api/v1/runners/claims/complete', { ...entry, runnerId: this.options.runnerId, result: entry.result });
      this.journal.save({ ...entry, phase: 'finished' });
    } catch (cause) {
      if (!(cause instanceof RunnerProtocolError) || (cause.status !== 409 && cause.status !== 400)) throw cause;
      this.journal.save({ ...entry, phase: 'reconciliation' });
      console.error('CiFn completion requires reconciliation; conflicting result retained');
    }
  }
  private async handle(claim: ResumableClaim): Promise<boolean> {
    if (claim.reconciliationRequired || !claim.payload) return false;
    let entry = this.journal.get(claim.dispatchId);
    if (!entry) {
      if (claim.executionId) return false; // Acknowledged elsewhere: never invent execution ownership.
      entry = this.journal.save({ version: 1, phase: 'prepared', runnerId: this.options.runnerId, runId: claim.runId, dispatchId: claim.dispatchId, claimToken: claim.claimToken, executionId: randomUUID() }, true);
    }
    if (entry.runnerId !== this.options.runnerId || (claim.executionId && claim.executionId !== entry.executionId)) return false;
    if (entry.phase === 'finished' || entry.phase === 'reconciliation') return false;
    if (entry.phase === 'completed') { await this.finish(entry); return true; }
    if (entry.phase === 'started' || this.journal.hasStarted(entry.dispatchId)) {
      if (!this.reportedUncertain.has(entry.dispatchId)) { console.error('CiFn execution requires reconciliation; automatic replay refused'); this.reportedUncertain.add(entry.dispatchId); }
      return false;
    }
    await this.request('/api/v1/runners/claims/ack', entry);
    if (!this.journal.markStarted(entry)) return false;
    const result = await executeRemoteShellJob(claim.payload);
    const completed = { ...entry, phase: 'completed' as const, result };
    this.journal.save(completed);
    await this.finish(completed);
    return true;
  }
  async tick(): Promise<number> {
    let processed = 0;
    for (const entry of this.journal.list()) {
      if (entry.runnerId === this.options.runnerId && entry.phase === 'completed') { await this.finish(entry); processed++; }
    }
    let cursor: string | undefined;
    do {
      const page: { claims: ResumableClaim[]; nextCursor?: string } = await this.request('/api/v1/runners/claims/resume', { runnerId: this.options.runnerId, cursor });
      for (const claim of page.claims) if (await this.handle(claim)) processed++;
      cursor = page.nextCursor;
    } while (cursor);
    const heartbeat = await this.request<{ job: JobPayload | null }>('/api/v1/runners/heartbeat', { runnerId: this.options.runnerId });
    if (heartbeat.job?.dispatchId && heartbeat.job.claimToken) {
      if (await this.handle({ payload: heartbeat.job, runId: heartbeat.job.runId, dispatchId: heartbeat.job.dispatchId, claimToken: heartbeat.job.claimToken, reconciliationRequired: false })) processed++;
    }
    return processed;
  }
}
