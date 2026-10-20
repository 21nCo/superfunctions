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

export interface FeedbackMetadata { tags: string[]; productArea: string | null; }
export function validateMetadataPatch(value: unknown): Partial<FeedbackMetadata> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FeedbackValidationError();
  const patch = value as Record<string, unknown>;
  if (!Object.keys(patch).length || Object.keys(patch).some(key => !['tags', 'productArea'].includes(key))) throw new FeedbackValidationError();
  const result: Partial<FeedbackMetadata> = {};
  if ('tags' in patch) {
    if (!Array.isArray(patch.tags) || patch.tags.length > 20 || patch.tags.some(tag => typeof tag !== 'string' || tag.length > 64)) throw new FeedbackValidationError();
    result.tags = [...new Set(patch.tags.map(tag => normalizeFilter(tag, 64)))].sort();
  }
  if ('productArea' in patch) {
    if (patch.productArea !== null && (typeof patch.productArea !== 'string' || patch.productArea.length > 100)) throw new FeedbackValidationError();
    result.productArea = patch.productArea === null ? null : normalizeFilter(patch.productArea as string, 100);
  }
  return result;
}

/** Read both projections inside the caller's transaction. The original payload remains immutable. */
export async function readFeedbackMetadata(database: TransactionAdapter, row: FeedbackRow): Promise<FeedbackMetadata> {
  const where = [{ field: 'tenantId', operator: 'eq' as const, value: row.tenantId }];
  const attributes = await database.findOne<{ productArea: string | null }>({ model: 'userfn_feedback_attributes', where: [...where, { field: 'id', operator: 'eq', value: row.id }] });
  if (!attributes) {
    if ((await readFilterMarker(database))?.status === 'ready') throw new Error('Feedback metadata projection is missing');
    const original = row.payload.feedback as { tags?: string[]; productArea?: string };
    return { tags: [...new Set((original.tags ?? []).map(tag => normalizeFilter(tag, 64)))].sort(), productArea: original.productArea === undefined ? null : normalizeFilter(original.productArea, 100) };
  }
  const tags = await database.findMany<{ tag: string }>({ model: 'userfn_feedback_tags', where: [...where, { field: 'feedbackId', operator: 'eq', value: row.id }], select: ['tag'], limit: 21, orderBy: [{ field: 'tag', direction: 'asc' }] });
  if (tags.length > 20) throw new Error('Feedback metadata projection exceeds tag bound');
  return { tags: tags.map(row => row.tag), productArea: attributes.productArea ?? null };
}

export async function patchFeedbackMetadata(database: TransactionAdapter, row: FeedbackRow, patch: Partial<FeedbackMetadata>): Promise<FeedbackMetadata> {
  if ((await readFilterMarker(database))?.status !== 'ready') throw new Error('Feedback filter backfill is incomplete');
  const where = [{ field: 'tenantId', operator: 'eq' as const, value: row.tenantId }];
  if (!await database.findOne({ model: 'userfn_feedback_attributes', where: [...where, { field: 'id', operator: 'eq', value: row.id }] })) throw new Error('Feedback metadata projection is missing');
  // Lock the existing projection row before replacing tag edges. SQL adapters hold
  // this update's row lock until commit, serializing mutations of the same item.
  await database.update({ model: 'userfn_feedback_attributes', where: [...where, { field: 'id', operator: 'eq', value: row.id }], data: { id: row.id } });
  if (patch.tags !== undefined) {
    await database.deleteMany({ model: 'userfn_feedback_tags', where: [...where, { field: 'feedbackId', operator: 'eq', value: row.id }] });
    for (const tag of patch.tags) {
      const id = 'ut_' + createHash('sha256').update(JSON.stringify([row.tenantId, row.id, tag])).digest('hex');
      await database.create({ model: 'userfn_feedback_tags', data: { id, tenantId: row.tenantId, feedbackId: row.id, tag } });
    }
  }
  if (patch.productArea !== undefined) await database.update({ model: 'userfn_feedback_attributes', where: [...where, { field: 'id', operator: 'eq', value: row.id }], data: { productArea: patch.productArea } });
  return readFeedbackMetadata(database, row);
}
