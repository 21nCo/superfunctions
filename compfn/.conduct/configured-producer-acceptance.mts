/** Local acceptance, run from repo root after `npm run build -w compfn`:
 * node_modules/.bin/tsx compfn/.conduct/configured-producer-acceptance.mts
 * Uses actual checked-out producer source APIs, not installed AuthFn/SecFn packages.
 * Sparse worktrees must materialize /authfn/core/ and /secfn/core/ first.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { drizzleAdapter } from '@superfunctions/db/adapters/drizzle';
import { compFn, createAuthfnAdapter, createSecfnAdapter, getCompfnSchema } from '../dist/index.js';
import { resolveCookiePolicy } from '../../authfn/core/src/core/cookies.js';
import { createSecurityScanner } from '../../secfn/core/src/scanner/scanner.js';

const dir = await mkdtemp(join(tmpdir(), 'compfn-producers-'));
const databasePath = join(dir, 'evidence.sqlite');
const scanner = createSecurityScanner({ maxFileSize: 4096 });
const authConfig = { cookie: { sessionMaxAgeSeconds: 1800, secure: true } };
const request = new Request('https://acceptance.invalid/account'); // In-process policy resolution, no network.
let scanCalls = 0;
let policyCalls = 0;
let sqlite: InstanceType<typeof Database> | undefined;
const definitions = getCompfnSchema().schemas;
const expected: Array<{ controlId: string; checkId: string; outcome: string; evidenceId: string; payload: unknown }> = [];
const unwrap = <T,>(result: { ok: true; result: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result;
};
function open() {
  sqlite = new Database(databasePath);
  const schema = Object.fromEntries(definitions.map(table => [table.modelName, sqliteTable(table.modelName,
    Object.fromEntries(Object.entries(table.fields).map(([name, field]) => [name,
      field.type === 'number' ? integer(name) : field.type === 'json' ? text(name, { mode: 'json' }) : text(name)])))]));
  for (const table of definitions) sqlite.exec('CREATE TABLE IF NOT EXISTS "' + table.modelName + '" (' +
    Object.entries(table.fields).map(([name, field]) => '"' + name + '" ' + (field.type === 'number' ? 'INTEGER' : 'TEXT') +
      (name === 'id' ? ' PRIMARY KEY' : '')).join(',') + ')');
  const database = drizzleAdapter({ db: drizzle(sqlite, { schema }), dialect: 'sqlite' });
  return compFn({ database, logger: { info() {}, debug() {}, warn() {}, error() {} }, adapters: {
    authfn: createAuthfnAdapter({ client: {
      async getSessionPolicy() {
        policyCalls++;
        const resolved = resolveCookiePolicy(authConfig, request);
        return { maxSessionAge: resolved.sessionMaxAgeSeconds, policy: 'seconds; configured secure cookie policy; no compliance threshold asserted' };
      },
      // No getMfaStatus: neither a configured 2FA plugin nor enrollment proves global enforcement.
    } }),
    secfn: createSecfnAdapter({ client: {
      async getSecretScanSummary(options) {
        const target = options?.customConfig?.target;
        assert.ok(target === 'clean.txt' || target === 'finding.txt' || target === 'missing.txt' || target === 'oversized.txt');
        const path = join(dir, target);
        // scanFile intentionally returns [] above maxFileSize; a bridge must not certify that skip.
        const info = await stat(path);
        if (!info.isFile() || info.size > 4096) return { status: 'skipped' };
        scanCalls++;
        const findings = await scanner.scanFile(path);
        // Only the successful awaited file scan certifies this explicitly scoped fixture.
        // Do not persist raw matches, secret context, or pretend this is a repository coverage result.
        return { status: 'completed', findings: findings.length, lastScanAt: Date.now() };
      },
    } }),
  } });
}
try {
  await writeFile(join(dir, 'clean.txt'), 'public non-sensitive fixture\n');
  // Synthetic high-entropy-looking detector fixture, never a real issued credential.
  await writeFile(join(dir, 'finding.txt'), 'token=' + 'ghp_' + '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' + '\n');
  await writeFile(join(dir, 'oversized.txt'), 'x'.repeat(4097));
  let api = open();
  for (const [name, adapterName, adapterMethod, customConfig, outcome] of [
    ['Clean explicit file', 'secfn', 'getSecretScanSummary', { target: 'clean.txt' }, 'pass'],
    ['Finding explicit file', 'secfn', 'getSecretScanSummary', { target: 'finding.txt' }, 'fail'],
    ['Missing file', 'secfn', 'getSecretScanSummary', { target: 'missing.txt' }, 'fail'],
    ['Skipped oversized file', 'secfn', 'getSecretScanSummary', { target: 'oversized.txt' }, 'unknown'],
    ['Configured session policy', 'authfn', 'getSessionPolicy', {}, 'unknown'],
    ['Unavailable MFA enforcement', 'authfn', 'getMfaStatus', {}, 'unknown'],
  ] as const) {
    const control = unwrap(await api.controls.create({ name, description: 'Owned local source-producer acceptance', category: 'security' }));
    const check = unwrap(await api.checks.create({ name, controlId: control.id, adapterName, adapterMethod, customConfig }));
    const run = unwrap(await api.checks.run(check.id));
    assert.equal(run.outcome, outcome);
    const evidence = unwrap(await api.evidence.get(run.evidenceId!));
    assert.equal(evidence.outcome, outcome);
    assert.equal(evidence.type, adapterName === 'secfn' ? 'automated_secfn' : 'automated_authfn');
    if (name === 'Clean explicit file' || name === 'Finding explicit file') {
      const summary = evidence.payload?.summary;
      assert.ok(summary && typeof summary === 'object' && 'findings' in summary);
      assert.equal(typeof summary.findings, 'number');
      if (name === 'Clean explicit file') assert.equal(summary.findings, 0);
      else assert.ok(Number(summary.findings) > 0);
    }
    if (name === 'Configured session policy') {
      const policy = evidence.payload?.sessionPolicy;
      assert.ok(policy && typeof policy === 'object' && 'maxSessionAge' in policy);
      assert.equal(policy.maxSessionAge, 1800);
    }
    const readiness = unwrap(await api.readiness.forControl(control.id));
    assert.equal(readiness.status, outcome === 'pass' ? 'compliant' : 'not_compliant');
    expected.push({ controlId: control.id, checkId: check.id, outcome, evidenceId: evidence.id, payload: evidence.payload });
  }
  assert.equal(scanCalls, 2);
  assert.equal(policyCalls, 1);
  sqlite!.close(); sqlite = undefined;
  api = open(); // New SQLite handle, adapter and CompFn instance; producer calls must not rerun on read.
  for (const item of expected) {
    const evidence = unwrap(await api.evidence.get(item.evidenceId));
    assert.equal(evidence.outcome, item.outcome);
    assert.deepEqual(evidence.payload, item.payload);
    const check = unwrap(await api.checks.get(item.checkId));
    assert.equal(check.controlId, item.controlId);
    const readiness = unwrap(await api.readiness.forControl(item.controlId));
    assert.equal(readiness.status, item.outcome === 'pass' ? 'compliant' : 'not_compliant');
    assert.equal(readiness.lastEvidenceId, item.evidenceId);
  }
  assert.equal(scanCalls, 2);
  assert.equal(policyCalls, 1);
  console.log(JSON.stringify({ status: 'passed', cases: expected.length, outcomes: expected.map(item => item.outcome), realFileScans: scanCalls,
    realAuthPolicyResolutions: policyCalls, sqliteReopenVerified: true, scope: 'explicit local files and configured session policy; MFA unavailable; no full-repository or live-provider claim' }));
} finally {
  sqlite?.close();
  await rm(dir, { recursive: true, force: true });
  await assert.rejects(access(dir), { code: 'ENOENT' });
  console.log(JSON.stringify({ cleanup: 'verified', directoryRemoved: true }));
}
