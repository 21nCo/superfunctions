import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const serverDir = join(repoRoot, 'filefn/server');
const serverRequire = createRequire(join(serverDir, 'package.json'));
const workspaceInstall = existsSync(join(repoRoot, 'node_modules'));

describe('server dependency pins (F-20)', () => {
  it.each([
    ['@superfunctions/db', 'packages/db'],
    ['@superfunctions/middleware', 'packages/middleware'],
    ['@filefn/processing', 'filefn/processing'],
  ])('resolves %s at the version in %s', (name, workspace) => {
    const server = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));
    const expected = JSON.parse(readFileSync(join(repoRoot, workspace, 'package.json'), 'utf8'));
    const entry = realpathSync(serverRequire.resolve(name));
    const installed = JSON.parse(readFileSync(join(dirname(entry), '../package.json'), 'utf8'));

    expect(server.dependencies[name] ?? server.devDependencies[name]).toBe(expected.version);
    expect(installed.name).toBe(name);
    expect(installed.version).toBe(expected.version);
    // Tagged publishing installs registry packages without building the workspace.
    if (workspaceInstall) {
      expect(entry).toBe(realpathSync(join(repoRoot, workspace, 'dist/index.js')));
    }
  });
});
