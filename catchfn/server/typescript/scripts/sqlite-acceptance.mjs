// Run after building shared DB, CatchFn SDK and server. Requires native better-sqlite3 and uv.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { CatchFnService, getCatchFnSchema } from '../dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const dir = await mkdtemp(resolve(tmpdir(), 'catchfn-sqlite-'));
const path = resolve(dir, 'reports.sqlite');
let connection;
const open = () => {
  const sql = new Kysely({ dialect: new SqliteDialect({ database: new Database(path) }) });
  connection = sql;
  const db = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { catchfn_bugs: 'catchfn_bugs' } });
  return { sql, service: new CatchFnService({ db, app: 'shop', now: () => 0 }), db };
};
const close = async () => { await connection.destroy(); connection = undefined; };
try {
  let { sql, service, db } = open();
  // Application-owned migration derives columns from the function-owned schema.
  let migration = sql.schema.createTable('catchfn_bugs');
  for (const [name, field] of Object.entries(getCatchFnSchema().catchfn_bugs.fields)) {
    migration = migration.addColumn(name, field.type === 'number' ? 'real' : 'text', column => {
      if (name === 'id') column = column.primaryKey();
      else if (field.unique) column = column.unique();
      return field.required ? column.notNull() : column;
    });
  }
  await migration.execute();
  const report = {
    id: 'typescript', timestamp: 1234.5, title: 'Unicode 文 report', severity: 'high',
    app: { name: 'shop', version: '1' }, tags: ['ui_%', '文'], sessionId: 'session', replayId: 'replay',
    steps: ['Open', 'Click'], integration: { issueId: 'issue-1' },
    attachments: [{ id: 'shot', name: 'shot.png', type: 'image/png', size: 12, kind: 'screenshot', annotationScene: { version: 1, elements: [] } }],
    metadata: { nested: [1, true, null, { label: '文' }], token: 'secret' },
    custom: { preserved: true },
  };
  const expected = await service.createBug(report);
  assert.equal(expected.metadata.token, '[REDACTED]');
  await new CatchFnService({ db, app: 'other', now: () => 0 }).createBug({ ...report, id: 'other', app: { name: 'other' } });
  await close();
  ({ sql, service, db } = open());
  assert.deepEqual(await service.getBug(report.id), expected);
  assert.deepEqual(await service.createBug(report), expected);
  await assert.rejects(service.createBug({ ...report, title: 'conflict' }), /already exists/);
  assert.equal(await new CatchFnService({ db, app: 'other' }).getBug(report.id), null);
  assert.deepEqual((await service.listBugs(50, 0, { tags: ['ui_%'], sessionId: 'session', replayId: 'replay', issueId: 'issue-1' })).map(x => x.id), ['typescript']);
  assert.deepEqual(await service.listBugs(50, 0, { tags: ['ui'] }), []);
  await close();
  await writeFile(resolve(dir, 'expected.json'), JSON.stringify(expected));
  const python = spawnSync('uv', ['run', '--isolated', '--no-project', '--python', process.env.CATCHFN_PYTHON ?? '3.10', '--with', 'sqlalchemy>=2,<3', '--with', 'pydantic>=2.5,<3', 'python', resolve(root, 'catchfn/server/python/tests/sqlite_cross_language.py'), path, resolve(dir, 'expected.json')], {
    cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONPATH: [resolve(root, 'catchfn/server/python/src'), resolve(root, 'packages/python-core'), resolve(root, 'packages/python-sqlalchemy')].join(delimiter) },
  });
  if (python.status !== 0) throw new Error(`Python acceptance failed:\n${python.stdout}\n${python.stderr}`);
  process.stdout.write(python.stdout);
  ({ service, db } = open());
  const pythonExpected = JSON.parse(await readFile(resolve(dir, 'expected.json.python'), 'utf8'));
  assert.deepEqual(await service.getBug('python'), pythonExpected);
  assert.deepEqual(await service.createBug(pythonExpected), pythonExpected);
  assert.deepEqual((await service.listBugs(50, 0, { tags: ['ui_%'] })).map(x => x.id), ['python', 'typescript']);
  assert.equal(await new CatchFnService({ db, app: 'shop', now: () => 3 * 86400000 }).cleanup(1), 2);
  assert.notEqual(await new CatchFnService({ db, app: 'other' }).getBug('other'), null);
  await close();
  ({ service } = open());
  assert.deepEqual(await service.listBugs(), []);
  console.log('CatchFn native SQLite close/reopen, JSON, scope, filters, duplicates, retention and TS/Python cross-read/write passed');
} finally {
  if (connection) await close();
  await rm(dir, { recursive: true, force: true });
}
