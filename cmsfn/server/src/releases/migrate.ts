import type { Adapter } from '@superfunctions/db';
import { cmsfnStorageAdapter } from '../storage/schema.js';
import { canonicalTime, parseExecution, nextReleaseVersion } from './journal.js';
/**
 * After additive DDL and draining all old writers, backfill a bounded page.
 * Resume using nextCursor; retry the same page on conflict. Invalid legacy times
 * require explicit operator correction and prevent a truthful readiness assertion.
 */
export async function backfillReleaseSchedules(db: Adapter, options: { cursor?: string; limit?: number } = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (options.cursor !== undefined && typeof options.cursor !== 'string')) throw new Error('Invalid migration page');
  const wrapped = cmsfnStorageAdapter(db);
  const rows = await wrapped.findMany({ model: 'cmsfn_releases', where: options.cursor ? [{ field: 'releaseId', operator: 'gt', value: options.cursor }] : [], orderBy: [{ field: 'releaseId', direction: 'asc' }], select: ['releaseId', 'updatedAt', 'publishAt', 'nextRunAt', 'execution'], limit });
  const invalid: string[] = [];
  let changed = 0;
  for (const row of rows) {
    if (typeof row.releaseId !== 'string') throw new Error('Invalid release identity');
    if ((row.execution != null && !parseExecution(row.execution)) || (row.nextRunAt != null && !canonicalTime(row.nextRunAt))) { invalid.push(row.releaseId); continue; }
    if (row.execution != null || row.nextRunAt != null || row.publishAt == null) continue;
    if (!canonicalTime(row.publishAt) || !canonicalTime(row.updatedAt)) { invalid.push(row.releaseId); continue; }
    const updatedAt = nextReleaseVersion(row.updatedAt);
    if (!updatedAt) { invalid.push(row.releaseId); continue; }
    const count = await wrapped.updateMany({ model: 'cmsfn_releases', where: [
      { field: 'releaseId', operator: 'eq', value: row.releaseId }, { field: 'updatedAt', operator: 'eq', value: row.updatedAt },
    ], data: { nextRunAt: row.publishAt, updatedAt } });
    if (count !== 1) throw new Error('Release changed during migration; retry this page');
    changed++;
  }
  return { changed, invalid, nextCursor: rows.length === limit ? String(rows[rows.length - 1].releaseId) : null };
}
