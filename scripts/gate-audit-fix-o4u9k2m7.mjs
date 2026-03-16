#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function run(command) {
  try {
    execSync(command, { stdio: 'pipe', encoding: 'utf8' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.stdout || error?.message || error) };
  }
}

function grep(pattern, paths) {
  const quoted = paths.map((p) => `"${p}"`).join(' ');
  return run(`rg -n "${pattern}" ${quoted}`);
}

function fileContains(path, pattern) {
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').includes(pattern);
}

const checklist = [
  {
    package: 'authfn',
    requirement: 'Adopt shared oauth-flow orchestration',
    command: 'rg -n "@superfunctions/oauth-flow" authfn/ts-sdk/src/social-oauth',
  },
  {
    package: 'plugfn',
    requirement: 'Adopt shared oauth-flow + persistent state store wiring',
    command:
      'rg -n "@superfunctions/oauth-flow|DEPRECATED_PATH|removal in plugfn@0.2.0" plugfn/typescript/src/core/connection-manager.ts plugfn/typescript/src/auth/oauth-flow.ts',
  },
  {
    package: 'recfn',
    requirement: 'Adopt shared oauth/token + extracted reuse packages',
    command:
      'rg -n "@superfunctions/oauth-flow|@superfunctions/webhooks|@superfunctions/envelope|@superfunctions/errors|@superfunctions/queue|@superfunctions/config|@superfunctions/metrics" recfn/server/src',
  },
  {
    package: 'cifn',
    requirement: 'Adopt extracted webhook/envelope/queue packages',
    command:
      'rg -n "@superfunctions/webhooks|@superfunctions/envelope|@superfunctions/errors|@superfunctions/queue" cifn/typescript/control-plane/src',
  },
  {
    package: 'searchfn',
    requirement: 'Consolidate adapter duplication with canonical source',
    command: 'node scripts/check-searchfn-adapter-canonical.mjs',
  },
  {
    package: 'packages/storage*',
    requirement: 'Deduplicate S3-compatible adapter internals',
    command:
      'rg -n "@superfunctions/storage/internal/s3-compatible" packages/storage-s3/src/adapter.ts packages/storage-r2/src/adapter.ts packages/storage-minio/src/adapter.ts',
  },
];

const commandChecks = [
  'npm -w docs run check:coverage',
  'npm -w docs run check:snippets',
  'npm -w docs run check:links',
];

const commandResults = commandChecks.map((command) => ({ command, ...run(command) }));

const checklistResults = checklist.map((item) => {
  const result = run(item.command);
  return {
    ...item,
    status: result.ok ? 'done' : 'pending',
    error: result.ok ? undefined : result.error,
  };
});

const pending = checklistResults.filter((item) => item.status !== 'done');
const failedCommands = commandResults.filter((item) => !item.ok);

const docsGateDoc = join(
  process.cwd(),
  '.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/RELEASE_GATE.md',
);
const gateDocPresent = existsSync(docsGateDoc);

const changelogTargets = [
  'packages/oauth-flow/CHANGELOG.md',
  'packages/oauth-testing/CHANGELOG.md',
  'plugfn/CHANGELOG.md',
  'recfn/server/CHANGELOG.md',
  'cifn/typescript/control-plane/CHANGELOG.md',
];
const missingChangelogs = changelogTargets.filter((p) => !existsSync(join(process.cwd(), p)));

const deprecationNoticeOk = fileContains(
  join(process.cwd(), 'plugfn/typescript/src/auth/oauth-flow.ts'),
  'DEPRECATED_PATH',
);

const ok =
  pending.length === 0 &&
  failedCommands.length === 0 &&
  gateDocPresent &&
  missingChangelogs.length === 0 &&
  deprecationNoticeOk;

const payload = {
  ok,
  gate: 'audit-fix-o4u9k2m7',
  packagesPassed: checklistResults
    .filter((item) => item.status === 'done')
    .map((item) => item.package),
  checklist: checklistResults,
  commandResults,
  gateDocPresent,
  missingChangelogs,
  deprecationNoticeOk,
};

if (ok) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

console.error(
  JSON.stringify({
    ...payload,
    error: {
      code: 'RELEASE_GATE_BLOCKED',
      pendingPackages: pending.map((p) => p.package),
    },
  }),
);
process.exit(1);
