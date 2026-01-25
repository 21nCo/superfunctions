import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgresAdapter } from '../src/storage/pg/adapter';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/storage/pg/schema';

// Skip integration tests if no DB URL provided
const dbUrl = process.env.DATABASE_URL;
const runIfDb = dbUrl ? describe : describe.skip;

runIfDb('PostgresAdapter Integration', () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle>;
  let adapter: PostgresAdapter;

  beforeEach(async () => {
    client = postgres(dbUrl!);
    db = drizzle(client, { schema });
    adapter = new PostgresAdapter(db);
    
    // Cleanup before test
    await db.delete(schema.memoryRelationships);
    await db.delete(schema.memories);
  });

  afterEach(async () => {
    await client.end();
  });

  it('should insert and retrieve a memory', async () => {
    const memory = {
      content: 'Test memory',
      tenantId: 'test-tenant',
      containerTags: ['user:1'],
      embedding: [0.1, 0.2, 0.3], // Dimensions should match schema in real usage (1536)
    };

    const inserted = await adapter.insertMemories([memory]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].id).toBeDefined();
    expect(inserted[0].content).toBe('Test memory');
  });

  it('should search by vector similarity', async () => {
    // Insert vectors
    await adapter.insertMemories([
      { content: 'A', embedding: [1, 0, 0], tenantId: 't1', containerTags: ['c1'] },
      { content: 'B', embedding: [0, 1, 0], tenantId: 't1', containerTags: ['c1'] },
    ]);

    // Search close to A
    const results = await adapter.searchVectors({
      embedding: [0.9, 0.1, 0],
      containerTags: ['c1'],
      topK: 1
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('A');
  });
});
