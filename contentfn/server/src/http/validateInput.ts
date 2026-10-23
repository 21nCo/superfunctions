import { err } from '@contentfn/core';

/** Validate optional properties before endpoint normalization can discard mistakes. */
export function validateOptionalInput(action: string, input: Record<string, unknown>) {
  if (input.dataset !== undefined && typeof input.dataset !== 'string') return err('VALIDATION_FAILED', 'dataset must be a string', { path: 'dataset' });
  const rules: Record<string, Record<string, string>> = {
    'docs.fork': { ifRev: 'string' },
    'docs.create': { id: 'string', asDraft: 'boolean' },
    'docs.get': { perspective: 'string' },
    'docs.delete': { purge: 'boolean' },
    'docs.patch': { ifRev: 'string' },
    'docs.publish': { ifRev: 'string' },
    'docs.unpublish': { ifRev: 'string' },
    'docs.restore': { ifRev: 'string' },
    'docs.history': { limit: 'number', cursor: 'string' },
    'assets.list': { limit: 'number', offset: 'number' },
    'webhooks.register': { secret: 'string' },
  };
  for (const [field, type] of Object.entries(rules[action] ?? {})) {
    if (input[field] !== undefined && !(field === 'cursor' && input[field] === null) && typeof input[field] !== type) return err('VALIDATION_FAILED', `${field} must be a ${type}`, { path: field });
  }
  if (action === 'docs.get' && input.perspective !== undefined && !['published', 'draft', 'raw'].includes(input.perspective as string)) return err('VALIDATION_FAILED', 'Invalid document perspective', { path: 'perspective' });
  if (action.startsWith('docs.') && input.id !== undefined && (typeof input.id !== 'string' || !input.id.replace(/^drafts\./, '') || /[\u0000-\u001f]/.test(input.id))) return err('VALIDATION_FAILED', 'Invalid document ID', { path: 'id' });
  if (action === 'assets.list') {
    for (const field of ['limit', 'offset']) if (input[field] !== undefined && (!Number.isSafeInteger(input[field]) || (input[field] as number) < (field === 'limit' ? 1 : 0))) return err('VALIDATION_FAILED', `${field} must be a valid integer`, { path: field });
  }
  return null;
}
