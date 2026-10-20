import { executeOwnedShell, ProcessGroupUncertainError } from './executor/owned-shell.js';
import { randomUUID } from 'node:crypto';
import { MemoryStore, MemoryQueueClient, DEFAULT_QUEUE_NAME, type JobPayload, type JobCompletion, type PipelineSpec } from '@cifn/control-plane';
import { Runner } from './runner.js';
import { MemoryLogFnClient } from './reporting/logfn-client.js';
import { ClaimJournal, type ClaimJournalEntry } from './claim-journal.js';

export interface RemoteRunnerOptions { baseUrl: string; runnerId: string; runnerSecret: string; stateDirectory: string; fetch?: typeof fetch }
interface ResumableClaim { payload?: JobPayload; runId: string; dispatchId: string; claimToken: string; executionId?: string; reconciliationRequired: boolean }

/** Reuses the real shell executor. The memory projection is scratch state only. */
export async function executeRemoteShellJob(payload: JobPayload, signal?: AbortSignal): Promise<JobCompletion> {
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
  const baseEnv = { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR };
  const runner = new Runner({ executionSignal: signal, runCommand: (command, workspace, env) => executeOwnedShell(command, workspace, { ...baseEnv, ...env }, signal), executionEnv: baseEnv, store, queue, logClient: new MemoryLogFnClient(), labels: [jobSpec['runs-on']],
    getSecret: async (_runId, name) => {
      if (!payload.secretSnapshot || !Object.prototype.hasOwnProperty.call(payload.secretSnapshot, name)) throw new Error('Required prepared secret is unavailable');
      return payload.secretSnapshot[name];
    },
    pipelineSpecs: new Map([[run.id, spec]]), secretValues: new Map([[run.id, [...Object.values(payload.env ?? {}), ...Object.values(payload.secretSnapshot ?? {})].filter(Boolean)]]) });
  try { await runner.processNextJob(); } catch (cause) { if (cause instanceof ProcessGroupUncertainError) throw cause; return failed(); }
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
      if (cause.status === 409 && (await this.status(entry)).cancelRequested) {
        const cancelled = { ...entry, phase: 'cancelled' as const };
        this.journal.save(cancelled); await this.stopped(cancelled); return;
      }
      this.journal.save({ ...entry, phase: 'reconciliation' });
      console.error('CiFn completion requires reconciliation; conflicting result retained');
    }
  }
  private async stopped(entry: ClaimJournalEntry): Promise<void> {
    await this.request('/api/v1/runners/claims/stopped', entry);
    this.journal.save({ ...entry, phase: 'finished' });
  }
  private status(entry: ClaimJournalEntry) {
    return this.request<{ cancelRequested: boolean; completed: boolean; stopped: boolean }>('/api/v1/runners/claims/status', entry);
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
    if (entry.phase === 'cancelled') { await this.stopped(entry); return true; }
    if (entry.phase === 'completed') { await this.finish(entry); return true; }
    if (entry.phase === 'started' || this.journal.hasStarted(entry.dispatchId)) {
      if (!this.reportedUncertain.has(entry.dispatchId)) { console.error('CiFn execution requires reconciliation; automatic replay refused'); this.reportedUncertain.add(entry.dispatchId); }
      return false;
    }
    const cancelBeforeStart = async () => {
      if (!(await this.status(entry!)).cancelRequested) return false;
      // Competing processes can share a journal. Claim the same exclusive
      // execution decision before asserting that no subprocess was started.
      if (!this.journal.markStarted(entry!)) return true;
      const cancelled = { ...entry!, phase: 'cancelled' as const };
      this.journal.save(cancelled); await this.stopped(cancelled); return true;
    };
    if (await cancelBeforeStart()) return true;
    try { await this.request('/api/v1/runners/claims/ack', entry); }
    catch (cause) { if (cause instanceof RunnerProtocolError && cause.status === 409 && await cancelBeforeStart()) return true; throw cause; }
    if (await cancelBeforeStart()) return true;
    if (!this.journal.markStarted(entry)) return false;
    const cancellation = new AbortController();
    let monitoring = true;
    let pending: Promise<void> | undefined;
    const observe = () => {
      if (pending || !monitoring) return;
      pending = this.status(entry!).then(status => { if (status.cancelRequested) cancellation.abort(); })
        .catch(() => { /* Network failures are not cancellation or proof of termination. */ })
        .finally(() => { pending = undefined; });
    };
    const timer = setInterval(observe, 1_000);
    try {
      observe();
      const result = await executeRemoteShellJob(claim.payload, cancellation.signal);
      const completed = { ...entry, phase: 'completed' as const, result };
      this.journal.save(completed);
      monitoring = false; clearInterval(timer); await pending;
      if (cancellation.signal.aborted) {
        const cancelled = { ...entry, phase: 'cancelled' as const };
        this.journal.save(cancelled); await this.stopped(cancelled);
      } else {
        await this.finish(completed);
      }
      return true;
    } finally { monitoring = false; clearInterval(timer); }

  }
  async tick(): Promise<number> {
    let processed = 0;
    for (const entry of this.journal.list()) {
      if (entry.runnerId === this.options.runnerId && entry.phase === 'cancelled') { await this.stopped(entry); processed++; }
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
