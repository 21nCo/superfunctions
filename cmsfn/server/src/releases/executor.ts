import { createLogger, type CmsfnLogger, type OperationContext } from '../logging/logger.js';
import { randomUUID } from 'node:crypto';
import type { Adapter } from '@superfunctions/db';
import { err, ok, evaluatePermissions, type CmsfnRole, type CmsfnEnvelope, type CmsfnReleasePublishResult } from 'cmsfn';
import { cmsfnStorageAdapter } from '../storage/schema.js';
import { fetchContentfnStatus } from '../contentfn/statusClient.js';
import { getDraftDoc, contentfnPublish } from '../publish/contentfnClient.js';
import { canPublish } from '../publish/gates.js';
import { isRecord } from '../contentfn/response.js';
import { newExecution, readExecutableRelease, saveExecution, nextReleaseVersion, type ReleaseExecution } from './journal.js';

export const PUBLISH_REPLAY_CAPABILITY = 'content.docs.publish.idempotency.v1';
const LEASE_MS = 60_000;
const RETRY_MS = 30_000;
/** Credentials stay in memory; only stable subject and publication metadata enter the journal. */
export interface ReleaseExecutionIdentity {
  subject: string;
  roles: CmsfnRole[];
  headers: NonNullable<RequestInit['headers']>;
}
export interface ReleaseExecutorConfig {
  logger?: CmsfnLogger;
  db: Adapter;
  /** Deployment assertion: additive DDL/backfill completed and old writers drained. */
  schemaVersion?: 2;
  contentfnBaseUrl: string;
  allowedDatasets: readonly string[];
  /** Host must resolve a verified, stable producer subject; never copy untrusted request headers. */
  resolveIdentity?: (input: { dataset: string; releaseId: string }) => Promise<ReleaseExecutionIdentity>;
}
interface RunInput { dataset: string; releaseId: string; origin: 'manual' | 'scheduled'; maxDocuments?: number; }
type Authorize = (type: string, action: 'release.manage' | 'doc.publish') => Promise<boolean>;
async function bounded<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Host policy timeout')), 2_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function summary(releaseId: string, execution: ReleaseExecution): CmsfnReleasePublishResult {
  return { releaseId, published: execution.documents.filter(doc => doc.state === 'published').map(doc => doc.docId),
    failures: execution.documents.filter(doc => doc.state === 'failed').map(doc => ({ docId: doc.docId, code: doc.code ?? 'INTERNAL_ERROR', message: doc.message ?? 'Publication failed' })),
    ...(execution.state === 'complete' ? {} : { execution: { runId: execution.runId, state: execution.state, pending: execution.documents.filter(doc => doc.state === 'pending' || doc.state === 'sending').map(doc => doc.docId) } }),
  };
}
/** Shared manual/scheduled claim. No timers are started until this explicit call. */
export async function executeRelease(config: ReleaseExecutorConfig, input: RunInput, authorizeManual?: Authorize): Promise<CmsfnEnvelope<CmsfnReleasePublishResult>> {
  if (input.origin !== 'scheduled') return executeReleaseOperation(config, input, authorizeManual);
  const operation = (config.logger ?? createLogger()).operation('releases.publish', { dataset: input.dataset, releaseId: input.releaseId, origin: 'scheduled' });
  try {
    const result = await executeReleaseOperation(config, input, authorizeManual, operation.context);
    operation.finish(result); return result;
  } catch { const result = err('INTERNAL_ERROR', 'Release execution failed'); operation.finish(result); return result; }
}
async function executeReleaseOperation(config: ReleaseExecutorConfig, input: RunInput, authorizeManual?: Authorize, logContext?: OperationContext): Promise<CmsfnEnvelope<CmsfnReleasePublishResult>> {
  if (input.origin === 'scheduled' && config.schemaVersion !== 2) return err('CONFLICT', 'Release schedule migration is not ready');
  if (!config.allowedDatasets.includes(input.dataset)) return err('PERMISSION_DENIED', 'Permission denied');
  const maxDocuments = input.maxDocuments ?? 500;
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 500) return err('VALIDATION_FAILED', 'Invalid document budget');
  const deadline = Date.now() + 20_000;
  let identity: ReleaseExecutionIdentity | undefined;
  let policyUnavailable = false;
  async function policy(type: string, action: 'release.manage' | 'doc.publish'): Promise<boolean> {
    policyUnavailable = false;
    try {
      if (config.resolveIdentity) {
        const resolved = await bounded(() => config.resolveIdentity!({ dataset: input.dataset, releaseId: input.releaseId }));
        if (!resolved || typeof resolved.subject !== 'string' || !resolved.subject.trim() || resolved.subject.length > 1024) { policyUnavailable = true; return false; }
        if (logContext) logContext.subject = resolved.subject;
        if (!evaluatePermissions(resolved.roles, { dataset: input.dataset, type, action }) || !evaluatePermissions(resolved.roles, { dataset: input.dataset, type: '*', action: 'release.manage' })) return false;
        if (identity && identity.subject !== resolved.subject) { policyUnavailable = true; return false; }
        identity = resolved;
      } else if (input.origin === 'scheduled') return false;
      return authorizeManual ? await bounded(() => authorizeManual('*', 'release.manage')) === true && (action === 'release.manage' || await bounded(() => authorizeManual(type, action)) === true) : !!identity;
    } catch { policyUnavailable = true; return false; }
  }
  // No claim, draft lookup or upstream status probe before local permission succeeds.
  if (!await policy('*', 'release.manage')) return err(policyUnavailable ? 'CONTENTFN_UNAVAILABLE' : 'PERMISSION_DENIED', 'Release execution is not authorized or policy is unavailable');
  let release;
  try { release = await readExecutableRelease(config.db, input.dataset, input.releaseId); }
  catch { return err('CONFLICT', 'Release execution metadata is invalid or storage is unavailable'); }
  if (!release) return err('NOT_FOUND', 'Release not found');
  const previous = release.execution;
  if (input.origin === 'scheduled' && (!release.nextRunAt || Date.parse(release.nextRunAt) > Date.now())) return err('CONFLICT', 'Release is not due');
  if (previous && previous.state !== 'complete' && previous.owner && Date.parse(previous.leaseUntil) > Date.now()) return err('CONFLICT', 'Release execution is already claimed');
  if (previous && previous.state !== 'complete' && previous.subject !== (identity?.subject ?? null)) return err('CONFLICT', 'Release recovery requires its original subject');
  if (previous && previous.state !== 'complete' && !previous.replay && previous.documents.some(doc => doc.state === 'sending')) return ok(summary(input.releaseId, { ...previous, state: 'uncertain' }));
  // Creation and membership edits are separate requests. Never consume an empty
  // schedule or freeze its membership before its first document is added.
  if ((!previous || previous.state === 'complete') && release.docIds.length === 0) {
    if (input.origin === 'scheduled' && !previous) {
      const updatedAt = nextReleaseVersion(release.updatedAt);
      if (!updatedAt) return err('CONFLICT', 'Release version is exhausted');
      try {
        const changed = await cmsfnStorageAdapter(config.db).updateMany({ model: 'cmsfn_releases', where: [
          { field: 'releaseId', operator: 'eq', value: input.releaseId },
          { field: 'dataset', operator: 'eq', value: input.dataset },
          { field: 'updatedAt', operator: 'eq', value: release.updatedAt },
        ], data: { updatedAt, nextRunAt: new Date(Date.now() + RETRY_MS).toISOString() } });
        if (changed !== 1) return err('CONFLICT', 'Release changed while awaiting documents');
      } catch { return err('CONFLICT', 'Release storage is unavailable'); }
    }
    return err('VALIDATION_FAILED', 'Add documents before publishing this release');
  }
  const execution = previous && previous.state !== 'complete' ? { ...previous, documents: previous.documents.map(doc => ({ ...doc })), owner: randomUUID(), state: 'running' as const, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() } : newExecution(release, input.origin, identity?.subject ?? null, !!identity, Date.now(), LEASE_MS);
  // A due scan must never create a second execution for a consumed schedule.
  if (input.origin === 'scheduled' && previous?.state === 'complete') return err('CONFLICT', 'Release schedule has completed');
  const recoveryEnabled = !!config.resolveIdentity;
  try {
    if (!await saveExecution(config.db, release, execution, recoveryEnabled ? execution.leaseUntil : null)) return err('CONFLICT', 'Release changed before execution was claimed');
    const persist = async (state: ReleaseExecution['state'], retry = false) => {
      execution.state = state;
      if (state !== 'running') execution.owner = '';
      execution.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      return saveExecution(config.db, release!, execution, state === 'complete' ? null : recoveryEnabled ? new Date(Date.now() + (retry ? RETRY_MS : LEASE_MS)).toISOString() : null);
    };
    const pause = async (state: 'blocked' | 'uncertain') => {
      if (!await persist(state, true)) return err('CONFLICT', 'Release claim changed; publication outcome must be recovered');
      return ok(summary(input.releaseId, execution));
    };
    if (execution.replay) {
      const status = await fetchContentfnStatus(config.contentfnBaseUrl, false, { headers: identity?.headers, required: ['content.docs', PUBLISH_REPLAY_CAPABILITY] });
      if (!status) return await pause(execution.documents.some(doc => doc.state === 'sending') ? 'uncertain' : 'blocked');
    }
    let attempted = 0;
    for (const doc of execution.documents) {
      if (doc.state === 'published' || doc.state === 'failed') continue;
      if (attempted >= maxDocuments || Date.now() >= deadline) return await pause(execution.documents.some(item => item.state === 'sending') ? 'uncertain' : 'blocked');
      attempted++;
      // Revalidate host roles/identity for every actual document. Stored type is the checked revision's type.
      const recovering = doc.state === 'sending';
      if (doc.state === 'pending') {
        const draft = await getDraftDoc({ baseUrl: config.contentfnBaseUrl, headers: identity?.headers, timeoutMs: 5_000, maxResponseBytes: 2 * 1024 * 1024, redirect: 'error' }, input.dataset, doc.docId);
        if (!draft.ok) {
          if (['CONTENTFN_UNAVAILABLE', 'RATE_LIMITED', 'INTERNAL_ERROR'].includes(draft.error.code) && draft.error.details?.failureKind !== 'invalid-result') return await pause('blocked');
          doc.state = 'failed'; doc.code = draft.error.code; doc.message = 'Draft could not be loaded';
        } else {
          if (!await policy(draft.result._type, 'doc.publish')) { if (policyUnavailable) return await pause('blocked'); doc.state = 'failed'; doc.code = 'PERMISSION_DENIED'; doc.message = 'Permission denied'; }
          else {
            const metadata = draft.result._cms;
            const state = isRecord(metadata) ? metadata.state : undefined;
            if (!canPublish(state as 'draft' | 'in_review' | 'approved' | 'published', true)) { doc.state = 'failed'; doc.code = 'PERMISSION_DENIED'; doc.message = 'Workflow state does not allow publish'; }
            else { doc.state = 'sending'; doc.revision = draft.result._rev; doc.type = draft.result._type; doc.key = `cmsfn:${execution.runId}:${randomUUID()}`; }
          }
        }
        // The revision, workflow decision and exact replay key are durable before a send can occur.
        if (!await persist('running')) return err('CONFLICT', 'Release claim changed before publication');
        if (doc.state === 'failed') continue;
      } else if (!await policy(doc.type!, 'doc.publish')) return await pause('uncertain');
      // Renew/CAS after every asynchronous prerequisite, including recovery policy. A stale owner cannot send a later document.
      if (!await persist('running')) return err('CONFLICT', 'Release claim changed before publication');
      const headers = new Headers(identity?.headers);
      if (execution.replay) headers.set('Idempotency-Key', doc.key!);
      const published = await contentfnPublish({ baseUrl: config.contentfnBaseUrl, headers, timeoutMs: 5_000, maxResponseBytes: 2 * 1024 * 1024, redirect: 'error' }, input.dataset, doc.docId, doc.revision);
      if (!published.ok && recovering) return await pause('uncertain');
      if (!published.ok && ['CONTENTFN_UNAVAILABLE','RATE_LIMITED','INTERNAL_ERROR'].includes(published.error.code)) return await pause('uncertain');
      if (published.ok) doc.state = 'published';
      else { doc.state = 'failed'; doc.code = published.error.code; doc.message = published.error.code === 'CONFLICT' ? 'Draft changed' : 'Publication was rejected'; }
      if (!await persist('running')) return err('CONFLICT', 'Release claim changed; publication outcome must be recovered');
    }
    if (!await persist('complete')) return err('CONFLICT', 'Release claim changed before completion');
    return ok(summary(input.releaseId, execution));
  } catch { return err('INTERNAL_ERROR', 'Release execution was interrupted; inspect the durable run before retrying'); }
}

export interface DueReleaseResult { results: Array<{ releaseId: string; dataset: string; outcome: CmsfnEnvelope<CmsfnReleasePublishResult> }>; }
/** One bounded host-driven sweep. Call repeatedly; future due times and expired claims survive restart. */
export async function executeDueReleases(config: ReleaseExecutorConfig, options: { limit?: number; maxDocuments?: number } = {}): Promise<DueReleaseResult> {
  const limit = options.limit ?? 10;
  const maxDocuments = options.maxDocuments ?? 20;
  if (!config.resolveIdentity || config.schemaVersion !== 2) throw new Error('Scheduled execution requires a trusted identity resolver and completed schema 2 migration');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 500) throw new Error('Invalid release execution bounds');
  const rows = await cmsfnStorageAdapter(config.db).findMany({ model: 'cmsfn_releases', where: [
    { field: 'dataset', operator: 'in', value: [...config.allowedDatasets] }, { field: 'nextRunAt', operator: 'lte', value: new Date(Date.now()).toISOString() },
  ], orderBy: [{ field: 'nextRunAt', direction: 'asc' }, { field: 'releaseId', direction: 'asc' }], select: ['dataset', 'releaseId', 'updatedAt'], limit });
  const results: DueReleaseResult['results'] = [];
  const deadline = Date.now() + 25_000;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    if (typeof row.dataset !== 'string' || typeof row.releaseId !== 'string') continue;
    const outcome = await executeRelease(config, { dataset: row.dataset, releaseId: row.releaseId, origin: 'scheduled', maxDocuments });
    // Denied/unavailable host policy must not monopolize the front of a bounded due scan.
    // Use the observed version so this cannot change another worker's newer claim.
    const updatedAt = nextReleaseVersion(row.updatedAt);
    if (!outcome.ok && updatedAt) await cmsfnStorageAdapter(config.db).updateMany({ model: 'cmsfn_releases', where: [
      { field: 'releaseId', operator: 'eq', value: row.releaseId }, { field: 'dataset', operator: 'eq', value: row.dataset }, { field: 'updatedAt', operator: 'eq', value: row.updatedAt },
    ], data: { nextRunAt: new Date(Date.now() + RETRY_MS).toISOString(), updatedAt } });
    results.push({ dataset: row.dataset, releaseId: row.releaseId, outcome });
  }
  return { results };
}
