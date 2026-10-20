/** Run after build: node --max-old-space-size=48 --max-semi-space-size=4 scripts/verify-query-streaming.mjs */
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { DatabaseStorage, getWatchFnSchema, QueryEngine } from '../dist/index.mjs';

const directory = await mkdtemp(join(tmpdir(), 'watch-stream-heap-'));
const filename = join(directory, 'events.sqlite');
const count = 20001;
let sql;
try {
  const native = new Database(filename);
  const schema = getWatchFnSchema().watchfn_events;
  native.exec(`CREATE TABLE watchfn_events (${Object.entries(schema.fields).map(([field, definition]) => `"${field}" ${definition.type === 'number' ? 'REAL' : 'TEXT'}${field === 'id' ? ' PRIMARY KEY' : ''}`).join(',')})`);
  const insert = native.prepare('INSERT INTO watchfn_events (id,payload) VALUES (?,?)');
  const padding = 'x'.repeat(8192);
  native.transaction(() => {
    for (let index = 0; index < count; index++) {
      insert.run(String(index).padStart(8, '0'), JSON.stringify({ id: index, name: index % 5 ? 'request' : 'error', type: 'track', timestamp: index, properties: { value: index, group: index % 7, keep: index % 137 === 0, padding } }));
    }
  })();
  sql = new Kysely({ dialect: new SqliteDialect({ database: native }) });
  const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { watchfn_events: 'watchfn_events' } });
  const storage = new DatabaseStorage(adapter);
  storage.getAll = async () => { throw new Error('materialized storage path is forbidden'); };
  storage.executeQuery = async () => { throw new Error('materialized storage path is forbidden'); };
  const query = new QueryEngine(storage);
  const first = await query.execute({ where: { keep: true }, timeRange: { from: 1, to: count }, limit: 3 });
  assert.deepEqual(first.data.map(row => row.id), [137, 274, 411]);
  const stats = await query.execute({ aggregations: { count: { operation: 'count' }, sum: { operation: 'sum', field: 'value' }, min: { operation: 'min', field: 'value' }, max: { operation: 'max', field: 'value' }, ratio: { operation: 'rate', numerator: { metric: 'error' }, denominator: { metric: 'request' } } } });
  assert.deepEqual(stats.data, [{ count, sum: count * (count - 1) / 2, min: 0, max: count - 1, ratio: 4001 / 16000 }]);
  const suffix = await query.aggregate({ metric: 'request.value', aggregation: 'sum' });
  let sum = 0; for (let index = 0; index < count; index++) if (index % 5) sum += index;
  assert.deepEqual(suffix.data, [{ value: sum }]);
  const grouped = await query.execute({ groupBy: 'group', aggregations: { count: { operation: 'count' } }, orderBy: { field: 'group', direction: 'asc' } });
  assert.equal(grouped.data.length, 7); assert.equal(grouped.data.reduce((sum, row) => sum + row.count, 0), count);
  // Exact numeric samples are small for this workload despite very large payloads.
  const samples = await query.execute({ aggregations: { avg: { operation: 'avg', field: 'value' }, median: { operation: 'percentile', field: 'value', percentile: 50 } } });
  let expectedMean = 0; for (let value = 0; value < count; value++) expectedMean += value / count;
  assert.deepEqual(samples.data, [{ avg: expectedMean, median: 10000 }]);
  console.log(JSON.stringify({ events: count, payloadPaddingBytes: 8192, databaseBytes: (await stat(filename)).size, heapLimitBytes: getHeapStatistics().heap_size_limit, heapUsedBytes: process.memoryUsage().heapUsed, limitedFilteredRows: true, completeScalarAndGroupedAggregates: true, suffixFallback: true, exactNumericSamples: true }));
} finally {
  await sql?.destroy();
  await rm(directory, { recursive: true, force: true });
}
