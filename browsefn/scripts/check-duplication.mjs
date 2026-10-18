#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const threshold = 5.0;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const outputDir = path.join(repoRoot, '.tmp', 'browsefn-jscpd');
const reportFile = path.join(outputDir, 'jscpd-report.json');

mkdirSync(outputDir, { recursive: true });

try {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      '--yes',
      'jscpd@5.4.1',
      'browsefn/typescript/src',
      'browsefn/python/browsefn',
      '--min-lines',
      '5',
      '--min-tokens',
      '50',
      '--reporters',
      'json',
      '--output',
      path.relative(repoRoot, outputDir),
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
} catch (error) {
  console.error('browsefn duplication scan failed');
  process.exit(error.status || 1);
}

if (!existsSync(reportFile)) {
  console.error(`missing duplication report at ${reportFile}`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportFile, 'utf8'));
const total = report.statistics?.total ?? {};
const duplicatedPercentage = Number(total.percentage ?? 0);
const payload = {
  ok: duplicatedPercentage <= threshold,
  threshold,
  scannedFiles: Number(total.sources ?? 0),
  clones: Number(total.clones ?? 0),
  duplicatedLines: Number(total.duplicatedLines ?? 0),
  duplicatedPercentage,
};

console.log(JSON.stringify(payload));

if (!payload.ok) {
  process.exit(1);
}
