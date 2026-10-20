import { createHash } from 'node:crypto';
import { wrapWithSchema, type Adapter, type TransactionAdapter } from '@superfunctions/db';
import { getUserFnSchema } from './schema.js';
import { FeedbackValidationError } from './validation.js';

const markerId = 'feedback-filters-v1';
interface Marker { id: string; status: 'building' | 'ready'; cursor: string | null; }
interface FeedbackRow { id: string; tenantId: string; payload: Record<string, unknown>; }
export function normalizeFilter(value: string, maximum: number): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum) throw new FeedbackValidationError();
  return normalized;
}
export const readFilterMarker = (database: Pick<Adapter, 'findOne'>) => database.findOne<Marker>({ model: 'userfn_feedback_migrations', where: [{ field: 'id', operator: 'eq', value: markerId }] });

export async function writeFeedbackFilters(database: TransactionAdapter, row: FeedbackRow): Promise<void> {
  const feedback = row.payload.feedback as { tags?: string[]; productArea?: string };
  for (const tag of new Set((feedback.tags ?? []).map(value => normalizeFilter(value, 64)))) {
    const id = 'ut_' + createHash('sha256').update(JSON.stringify([row.tenantId, row.id, tag])).digest('hex');
    await database.upsert({ model: 'userfn_feedback_tags', where: [{ field: 'id', operator: 'eq', value: id }], conflictTarget: 'id',
      create: { id, tenantId: row.tenantId, feedbackId: row.id, tag }, update: { tag } });
  }
  const productArea = feedback.productArea === undefined ? null : normalizeFilter(feedback.productArea, 100);
  await database.upsert({ model: 'userfn_feedback_attributes', where: [{ field: 'id', operator: 'eq', value: row.id }], conflictTarget: 'id',
    create: { id: row.id, tenantId: row.tenantId, productArea }, update: { productArea } });
}

/** Offline single-worker migration: stop old writers, apply schema, call until done. Safe to resume/repeat. */
export async function backfillFeedbackFilters(adapter: Adapter, options: { batchSize?: number } = {}) {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new TypeError('batchSize must be 1–500');
  if (!adapter.capabilities.transactions.supported) throw new Error('Feedback filter migration requires transactions');
  const database = wrapWithSchema(adapter, getUserFnSchema());
  return database.transaction(async tx => {
    let marker = await readFilterMarker(tx);
    if (marker?.status === 'ready') return { processed: 0, done: true };
    if (!marker) {
      marker = { id: markerId, status: 'building', cursor: null };
      await tx.create({ model: 'userfn_feedback_migrations', data: marker });
    }
    const rows = await tx.findMany<FeedbackRow>({ model: 'userfn_feedback', where: marker.cursor ? [{ field: 'id', operator: 'gt', value: marker.cursor }] : [], limit: batchSize + 1, orderBy: [{ field: 'id', direction: 'asc' }] });
    const batch = rows.slice(0, batchSize);
    for (const row of batch) await writeFeedbackFilters(tx, row);
    const done = rows.length <= batchSize;
    await tx.update({ model: 'userfn_feedback_migrations', where: [{ field: 'id', operator: 'eq', value: markerId }], data: { status: done ? 'ready' : 'building', cursor: batch.at(-1)?.id ?? marker.cursor } });
    return { processed: batch.length, done };
  });
}
