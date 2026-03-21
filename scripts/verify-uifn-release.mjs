#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const dryRun = process.argv.includes('--dry-run');

const checks = ['build', 'lint', 'test', 'type', 'export-map', 'pack'];

const packages = [
  {
    name: '@uifn/core',
    dir: 'uifn/core',
    status: 'GA',
    requiredExports: ['.', './aria/*', './state/*', './utils/*', './primitives/*'],
  },
  {
    name: '@uifn/react',
    dir: 'uifn/react',
    status: 'GA',
    requiredExports: ['.'],
  },
  {
    name: '@uifn/svelte',
    dir: 'uifn/svelte',
    status: 'GA',
    requiredExports: ['.'],
  },
  {
    name: '@uifn/vue',
    dir: 'uifn/vue',
    status: 'Experimental',
    requiredExports: ['.'],
  },
  {
    name: '@uifn/files',
    dir: 'uifn/files',
    status: 'Experimental',
    requiredExports: ['.'],
  },
];

function run(command, cwd) {
  execSync(command, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
}

function getScripts(packageJson) {
  return packageJson.scripts || {};
}

function verifyExportMap(pkg, packageJson) {
  const exportsField = packageJson.exports;
  if (!exportsField || typeof exportsField !== 'object') {
    throw new Error(`${pkg.name}: missing exports map`);
  }

  for (const key of pkg.requiredExports) {
    if (!(key in exportsField)) {
      throw new Error(`${pkg.name}: missing exports entry \"${key}\"`);
    }
  }
}

function runPackageChecks(pkg) {
  const pkgPath = path.join(repoRoot, pkg.dir);
  const packageJsonPath = path.join(pkgPath, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const scripts = getScripts(packageJson);

  verifyExportMap(pkg, packageJson);

  const scriptMap = {
    build: scripts.build,
    lint: scripts.lint,
    test: scripts.test,
    type: scripts.typecheck,
  };

  for (const key of ['build', 'lint', 'test', 'type']) {
    if (!scriptMap[key]) {
      throw new Error(`${pkg.name}: missing required script \"${key === 'type' ? 'typecheck' : key}\"`);
    }
  }

  run('npm run build', pkgPath);
  run('npm run lint', pkgPath);
  run('npm run test -- --run', pkgPath);
  run('npm run typecheck', pkgPath);
  run('npm pack --dry-run', pkgPath);
}

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        mode: 'dry-run',
        command: 'npm run verify:uifn-release',
        checks,
        requiredPackages: packages.filter((p) => p.status === 'GA').map((p) => p.name),
        publicPackages: packages.map((p) => ({ name: p.name, status: p.status })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const failures = [];
for (const pkg of packages) {
  try {
    runPackageChecks(pkg);
  } catch (error) {
    failures.push({
      package: pkg.name,
      error: String(error?.message || error),
    });
  }
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        command: 'verify:uifn-release',
        checks,
        failures,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      command: 'verify:uifn-release',
      checks,
      packages: packages.map((p) => p.name),
    },
    null,
    2,
  ),
);
