import { randomUUID } from 'node:crypto';
import type { Adapter } from '@superfunctions/db';
import { cmsfnStorageAdapter } from '../storage/schema.js';
import { isRecord } from '../contentfn/response.js';
import { MAX_DOCS_PER_RELEASE } from '../limits/limits.js';

export interface ReleaseDocumentAttempt {
  docId: string;
  state: 'pending' | 'sending' | 'published' | 'failed';
  revision?: string;
  type?: string;
  key?: string;
  code?: string;
  message?: string;
}
export interface ReleaseExecution {
  version: 1;
  runId: string;
  owner: string;
  leaseUntil: string;
  origin: 'manual' | 'scheduled';
  subject: string | null;
  replay: boolean;
  state: 'running' | 'complete' | 'uncertain' | 'blocked';
  documents: ReleaseDocumentAttempt[];
}
export interface ExecutableRelease {
  dataset: string; releaseId: string; updatedAt: string; publishAt: string | null;
  docIds: string[]; execution: ReleaseExecution | null; nextRunAt: string | null;
}
export function canonicalTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 && time < 8_640_000_000_000_000 && new Date(time).toISOString() === value;
}
export function nextReleaseVersion(value: unknown): string | null {
  if (!canonicalTime(value)) return null;
  const next = new Date(Math.max(Date.now(), Date.parse(value) + 1)).toISOString();
  return canonicalTime(next) ? next : null;
}
export function parseExecution(value: unknown): ReleaseExecution | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.runId !== 'string' || !value.runId || typeof value.owner !== 'string' || !canonicalTime(value.leaseUntil) ||
    !['manual','scheduled'].includes(String(value.origin)) || (value.subject !== null && (typeof value.subject !== 'string' || !value.subject.trim())) || typeof value.replay !== 'boolean' ||
    !['running','complete','uncertain','blocked'].includes(String(value.state)) || !Array.isArray(value.documents) || value.documents.length > MAX_DOCS_PER_RELEASE) return null;
  const documents: ReleaseDocumentAttempt[] = [];
  for (const item of value.documents) {
    if (!isRecord(item) || typeof item.docId !== 'string' || !item.docId || documents.some(doc => doc.docId === item.docId) || !['pending','sending','published','failed'].includes(String(item.state))) return null;
    for (const field of ['revision','type','key','code','message']) if (item[field] !== undefined && typeof item[field] !== 'string') return null;
    if (item.state === 'sending' && (!item.revision || !item.type || !item.key)) return null;
    documents.push({ docId: item.docId, state: item.state as ReleaseDocumentAttempt['state'],
      ...(typeof item.revision === 'string' ? { revision: item.revision } : {}),
      ...(typeof item.type === 'string' ? { type: item.type } : {}),
      ...(typeof item.key === 'string' ? { key: item.key } : {}),
      ...(typeof item.code === 'string' ? { code: item.code } : {}),
      ...(typeof item.message === 'string' ? { message: item.message } : {}),
    });
  }
  if (value.state === 'complete' && documents.some(doc => doc.state === 'pending' || doc.state === 'sending')) return null;
  return { version: 1, runId: value.runId, owner: value.owner, leaseUntil: value.leaseUntil, origin: value.origin as ReleaseExecution['origin'], subject: value.subject, replay: value.replay, state: value.state as ReleaseExecution['state'], documents };
}
export async function readExecutableRelease(db: Adapter, dataset: string, releaseId: string): Promise<ExecutableRelease | null> {
  const row = await cmsfnStorageAdapter(db).findOne({ model: 'cmsfn_releases', where: [{ field: 'dataset', operator: 'eq', value: dataset }, { field: 'releaseId', operator: 'eq', value: releaseId }] });
  if (!row) return null;
  if (!canonicalTime(row.updatedAt) || !Array.isArray(row.docIds) || row.docIds.length > MAX_DOCS_PER_RELEASE || !row.docIds.every((id: unknown): id is string => typeof id === 'string' && !!id) || new Set(row.docIds).size !== row.docIds.length) throw new Error('Invalid release journal');
  if (row.publishAt != null && !canonicalTime(row.publishAt)) throw new Error('Invalid release schedule');
  if (row.nextRunAt != null && !canonicalTime(row.nextRunAt)) throw new Error('Invalid release due time');
  const execution = row.execution == null ? null : parseExecution(row.execution);
  if (row.execution != null && !execution) throw new Error('Invalid release execution');
  return { dataset, releaseId, updatedAt: row.updatedAt, docIds: [...row.docIds], publishAt: row.publishAt ?? null, nextRunAt: row.nextRunAt ?? null, execution };
}
/** Every owner transition includes the captured version; a superseded worker cannot write. */
export async function saveExecution(db: Adapter, release: ExecutableRelease, execution: ReleaseExecution, nextRunAt: string | null): Promise<boolean> {
  const updatedAt = nextReleaseVersion(release.updatedAt);
  if (!updatedAt) throw new Error('Invalid or exhausted release version');
  const changed = await cmsfnStorageAdapter(db).updateMany({ model: 'cmsfn_releases', where: [
    { field: 'dataset', operator: 'eq', value: release.dataset }, { field: 'releaseId', operator: 'eq', value: release.releaseId }, { field: 'updatedAt', operator: 'eq', value: release.updatedAt },
  ], data: { execution: structuredClone(execution), nextRunAt, updatedAt } });
  if (changed !== 1) return false;
  release.updatedAt = updatedAt; release.execution = execution; release.nextRunAt = nextRunAt;
  return true;
}
export function newExecution(release: ExecutableRelease, origin: ReleaseExecution['origin'], subject: string | null, replay: boolean, now: number, leaseMs: number): ReleaseExecution {
  return { version: 1, runId: randomUUID(), owner: randomUUID(), leaseUntil: new Date(now + leaseMs).toISOString(), origin, subject, replay, state: 'running', documents: [...release.docIds].sort().map(docId => ({ docId, state: 'pending' })) };
}
