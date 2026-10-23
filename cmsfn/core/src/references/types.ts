/** Reference picker transport carries bounded metadata, never full documents. */
export interface CmsfnReferenceInput { dataset: string; types: string[]; search?: string; cursor?: string | null; limit?: number }
export interface CmsfnReferenceCandidate { _id: string; _type: string; label: string }
export interface CmsfnReferencePage { dataset: string; data: CmsfnReferenceCandidate[]; nextCursor: string | null }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseReferenceInput(value: unknown): CmsfnReferenceInput | null {
  if (!record(value) || typeof value.dataset !== 'string' || !value.dataset || value.dataset.length > 128 || !Array.isArray(value.types) || value.types.length < 1 || value.types.length > 50 || !value.types.every(type => typeof type === 'string' && !!type && type.length <= 128) || (value.search !== undefined && (typeof value.search !== 'string' || value.search.length > 128)) || (value.cursor !== undefined && value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length > 65536)) || (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 20))) return null;
  return { dataset: value.dataset, types: [...new Set(value.types)].sort(), search: typeof value.search === 'string' ? value.search.trim() : '', cursor: typeof value.cursor === 'string' ? value.cursor : null, limit: typeof value.limit === 'number' ? value.limit : 20 };
}
export function parseReferencePage(value: unknown, input: CmsfnReferenceInput): CmsfnReferencePage | null {
  if (!record(value) || value.dataset !== input.dataset || !Array.isArray(value.data) || value.data.length > (input.limit ?? 20) || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 65536))) return null;
  const data: CmsfnReferenceCandidate[] = []; const seen = new Set<string>();
  for (const item of value.data) {
    if (!record(item) || typeof item._id !== 'string' || !item._id || item._id.startsWith('drafts.') || item._id.length > 32768 || typeof item._type !== 'string' || !input.types.includes(item._type) || typeof item.label !== 'string' || item.label.length > 160 || seen.has(item._id)) return null;
    seen.add(item._id); data.push({ _id: item._id, _type: item._type, label: item.label });
  }
  return { dataset: input.dataset, data, nextCursor: value.nextCursor };
}
export function referenceQuery(input: CmsfnReferenceInput) {
  return { dataset: input.dataset, perspective: 'published', types: input.types, orderBy: [{ field: '_id', direction: 'asc' }], projection: { fields: ['_id', '_type', 'title', 'name'] }, ...(input.search ? { filter: { op: 'or', filters: ['_id', 'title', 'name'].map(field => ({ field, op: 'contains', value: input.search })) } } : {}), ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit ?? 20 };
}
/** ContentFn's query route scopes storage by dataset; rows do not carry a dataset field. */
export function projectReferencePage(value: unknown, input: CmsfnReferenceInput): CmsfnReferencePage | null {
  if (!record(value) || !Array.isArray(value.data) || (value.dataset !== undefined && value.dataset !== input.dataset)) return null;
  const data: unknown[] = [];
  for (const item of value.data) {
    if (!record(item)) return null;
    const label = typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : typeof item._id === 'string' ? item._id : '';
    data.push({ _id: item._id, _type: item._type, label: label.slice(0, 160) });
  }
  return parseReferencePage({ dataset: input.dataset, data, nextCursor: value.nextCursor }, input);
}
