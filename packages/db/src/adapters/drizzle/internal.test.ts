import { describe, expect, it } from 'vitest';
import { createDrizzleInternalCrud } from './internal.js';

describe('createDrizzleInternalCrud', () => {
  it('uses IS NULL and IS NOT NULL for null equality predicates', async () => {
    const executedQueries: any[] = [];
    const db = {
      async execute(query: any) {
        executedQueries.push(query);
        return [];
      },
    };

    const internal = createDrizzleInternalCrud(db, 'postgres');

    await internal.findOne('__datafn_meta', [
      { field: 'deletedAt', op: 'eq', value: null },
    ]);
    expect(JSON.stringify(executedQueries[0]?.queryChunks ?? [])).toContain('IS NULL');

    await internal.findOne('__datafn_meta', [
      { field: 'deletedAt', op: 'ne', value: null },
    ]);
    expect(JSON.stringify(executedQueries[1]?.queryChunks ?? [])).toContain('IS NOT NULL');
  });
});
