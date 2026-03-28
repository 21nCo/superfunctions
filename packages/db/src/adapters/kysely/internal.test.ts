import { describe, expect, it } from 'vitest';
import { createKyselyInternalCrud } from './internal.js';

describe('createKyselyInternalCrud', () => {
  it('uses IS NULL and IS NOT NULL for null equality predicates', async () => {
    const compiledNodes: any[] = [];
    const executor = {
      transformQuery(node: any) {
        return node;
      },
      compileQuery(node: any) {
        compiledNodes.push(node);
        return { sql: 'compiled', parameters: [] };
      },
      async executeQuery() {
        return { rows: [] };
      },
    };

    const db = {
      getExecutor() {
        return executor;
      },
      schema: {
        createTable() {
          throw new Error('schema access not expected in this test');
        },
      },
    };

    const internal = createKyselyInternalCrud(db, 'postgres');

    await internal.findOne('__datafn_meta', [
      { field: 'deletedAt', op: 'eq', value: null },
    ]);
    expect(JSON.stringify(compiledNodes[0])).toContain('IS NULL');

    await internal.findOne('__datafn_meta', [
      { field: 'deletedAt', op: 'ne', value: null },
    ]);
    expect(JSON.stringify(compiledNodes[1])).toContain('IS NOT NULL');
  });
});
