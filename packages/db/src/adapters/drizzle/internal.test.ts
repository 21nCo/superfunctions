import { describe, expect, it } from 'vitest';
import { createDrizzleInternalCrud } from './internal.js';

describe('createDrizzleInternalCrud', () => {
  it('rejects empty create payloads before building SQL', async () => {
    const db = {
      async execute() {
        throw new Error('execute should not be called');
      },
    };

    const internal = createDrizzleInternalCrud(db, 'postgres');

    await expect(internal.create('__datafn_meta', {})).rejects.toThrow(
      'create: data must not be empty',
    );
  });

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

  it('uses SQL list predicates for internal in and not_in operators', async () => {
    const executedQueries: any[] = [];
    const db = {
      async execute(query: any) {
        executedQueries.push(query);
        return [];
      },
    };

    const internal = createDrizzleInternalCrud(db, 'postgres');

    await internal.findMany('__datafn_changes', [
      { field: 'resource', op: 'in', value: ['task', 'goal'] },
    ]);
    const inQuery = JSON.stringify(executedQueries[0]?.queryChunks ?? []);
    expect(inQuery).toContain('IN');
    expect(inQuery).not.toContain('undefined');

    await internal.findMany('__datafn_changes', [
      { field: 'resource', op: 'not_in', value: ['task', 'goal'] },
    ]);
    const notInQuery = JSON.stringify(executedQueries[1]?.queryChunks ?? []);
    expect(notInQuery).toContain('NOT IN');
    expect(notInQuery).not.toContain('undefined');
  });

  it('rejects non-array internal list predicate values', async () => {
    const db = {
      async execute() {
        throw new Error('execute should not be called');
      },
    };

    const internal = createDrizzleInternalCrud(db, 'postgres');

    await expect(
      internal.findMany('__datafn_changes', [
        { field: 'resource', op: 'in', value: 'task' },
      ]),
    ).rejects.toThrow('Internal CRUD in operator value must be an array');
  });

  it('reads Cloudflare D1 affected-row counts from result meta', async () => {
    // drizzle-orm/d1 run() resolves to the raw D1Result.
    const changes = [1, 0];
    const db = {
      async run() {
        return { success: true, results: [], meta: { changes: changes.shift(), last_row_id: 0 } };
      },
    };

    const internal = createDrizzleInternalCrud(db, 'sqlite');
    const where = [{ field: 'namespace', op: 'eq' as const, value: 'ns' }];

    await expect(internal.update('__datafn_meta', where, { next_server_seq: 2 })).resolves.toBe(1);
    // A lost compare-and-swap must read as zero rows, never NaN.
    await expect(internal.delete('__datafn_meta', where)).resolves.toBe(0);
  });
});
