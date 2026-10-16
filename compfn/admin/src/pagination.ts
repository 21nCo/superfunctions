import { AdminError, decodeAdminCursor, encodeAdminCursor, normalizeAdminPageLimit, stableSerialize, type AdminOperationContext } from '@superfunctions/admin';
import type { CompFnAdminListInput } from './index.js';

type Row = Record<string, unknown>;
type Resource = 'frameworks' | 'controls' | 'checks' | 'evidence';
export const fields = {
  frameworks: { search: ['id', 'name', 'description', 'version'], filter: ['id', 'name', 'version'], sort: ['createdAt', 'updatedAt', 'name', 'version', 'id'], default: 'updatedAt' },
  controls: { search: ['id', 'name', 'description', 'category'], filter: ['id', 'category', 'tags'], sort: ['createdAt', 'updatedAt', 'name', 'category', 'id'], default: 'updatedAt' },
  checks: { search: ['id', 'name', 'controlId', 'adapterName'], filter: ['id', 'controlId', 'adapterName'], sort: ['createdAt', 'updatedAt', 'name', 'id'], default: 'updatedAt' },
  evidence: { search: ['id', 'controlId', 'actorId', 'type', 'sourceId'], filter: ['id', 'controlId', 'frameworkId', 'type', 'since', 'outcome', 'actorId'], sort: ['createdAt', 'timestamp', 'type', 'outcome', 'id'], default: 'timestamp' },
};
const invalid = () => new AdminError('invalid_argument', 'Invalid list filters, sorting, or pagination cursor.');
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return a < b ? -1 : 1;
}

/** Domain-specific keyset positions authenticate the shared scope-bound cursor. */
export function createCompFnPaginator(secret?: Uint8Array) {
  const bytes = secret?.slice() ?? crypto.getRandomValues(new Uint8Array(32));
  if (bytes.length < 32) throw new AdminError('invalid_argument', 'cursorSecret must contain at least 32 bytes.');
  const key = crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return async (resource: Resource, input: CompFnAdminListInput, context: AdminOperationContext, load: (filter: Row) => Promise<object[]>) => {
    const definition = fields[resource];
    const limit = normalizeAdminPageLimit(input.limit);
    const filter = input.filter ?? {};
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw invalid();
    for (const [field, value] of Object.entries(filter)) {
      if (!(definition.filter as readonly string[]).includes(field)) throw invalid();
      if (field === 'since' ? typeof value !== 'number' || !Number.isFinite(value)
        : field === 'tags' ? !Array.isArray(value) || value.some(item => typeof item !== 'string')
        : typeof value !== 'string') throw invalid();
    }
    if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 500)) throw invalid();
    if (input.sort !== undefined && !Array.isArray(input.sort)) throw invalid();
    const sort = input.sort?.length ? [...input.sort] : [{ field: definition.default, direction: 'desc' as const }];
    if (!Array.isArray(input.sort ?? []) || sort.length > 10 || sort.some(part => !part || !(definition.sort as readonly string[]).includes(part.field) || !['asc', 'desc'].includes(part.direction))) throw invalid();
    if (!sort.some(part => part.field === 'id')) sort.push({ field: 'id', direction: 'asc' });
    const query = stableSerialize({ filter, search: input.search ?? '', sort, scope: context.scope });
    let after: unknown[] | undefined;
    if (input.cursor) {
      try {
        if (input.cursor.length > 10000) throw invalid();
        const [encoded, signature, extra] = input.cursor.split('.');
        if (!encoded || !signature || extra !== undefined || !/^[a-f0-9]{64}$/.test(signature)) throw invalid();
        const signatureBytes = Uint8Array.from(signature.match(/../g)!, byte => parseInt(byte, 16));
        if (!await crypto.subtle.verify('HMAC', await key, signatureBytes, new TextEncoder().encode(encoded))) throw invalid();
        const position = decodeAdminCursor<{ resource: string; query: string; after: unknown[]; expiresAt: number }>(encoded, context.scope);
        if (position.resource !== resource || position.query !== query || position.expiresAt <= Date.now() || !Array.isArray(position.after) || position.after.length !== sort.length) throw invalid();
        after = position.after;
      } catch { throw invalid(); }
    }
    const tuple = (row: Row) => sort.map(part => row[part.field] ?? null);
    const order = (left: unknown[], right: unknown[]) => {
      for (let index = 0; index < sort.length; index++) {
        const result = compare(left[index], right[index]) * (sort[index].direction === 'asc' ? 1 : -1);
        if (result) return result;
      }
      return 0;
    };
    let rows = (await load(filter)).map(value => ({ ...value }) as Row).filter(row => Object.entries(filter).every(([field, value]) => {
      if (field === 'frameworkId') return true; // Resolved through the core evidence service's framework mapping.
      if (field === 'since') return typeof row.timestamp === 'number' && row.timestamp >= (value as number);
      if (field === 'tags') return !(value as string[]).length || Array.isArray(row.tags) && (value as string[]).some(tag => (row.tags as unknown[]).includes(tag));
      return row[field] === value;
    }));
    if (input.search) {
      const search = input.search.toLowerCase();
      rows = rows.filter(row => definition.search.some(field => typeof row[field] === 'string' && (row[field] as string).toLowerCase().includes(search)));
    }
    rows.sort((a, b) => order(tuple(a), tuple(b)));
    if (after) rows = rows.filter(row => order(tuple(row), after!) > 0);
    const items = rows.slice(0, limit);
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const encoded = encodeAdminCursor(context.scope, { resource, query, after: tuple(items[items.length - 1]), expiresAt: Date.now() + 15 * 60_000 });
      const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(encoded)));
      nextCursor = encoded + '.' + [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return { ok: true as const, data: { items: JSON.parse(JSON.stringify(items)), nextCursor } };
  };
}
