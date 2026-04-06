import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorkspaceManager } from '../../core/workspace.js';

const execSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

describe('WorkspaceManager.generateLockfile', () => {
  let rootDir: string;
  let serviceDir: string;
  let targetDir: string;

  beforeEach(() => {
    execSyncMock.mockReset();
    rootDir = mkdtempSync(join(tmpdir(), 'hostfn-workspace-root-'));
    serviceDir = join(rootDir, 'services', 'api');
    targetDir = mkdtempSync(join(tmpdir(), 'hostfn-workspace-target-'));

    mkdirSync(serviceDir, { recursive: true });

    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify({
        private: true,
        workspaces: ['services/*'],
      }, null, 2),
    );

    writeFileSync(
      join(serviceDir, 'package.json'),
      JSON.stringify({
        name: '@hostfn/api',
        dependencies: {
          commander: '^12.0.0',
          chalk: '^5.0.0',
        },
      }, null, 2),
    );

    writeFileSync(
      join(rootDir, 'package-lock.json'),
      JSON.stringify({
        name: 'workspace-root',
        lockfileVersion: 3,
        packages: {
          '': { name: 'workspace-root' },
          'node_modules/commander': { version: '4.1.1', name: 'commander' },
          'services/api/node_modules/commander': { version: '12.1.0', name: 'commander' },
          'node_modules/chalk': { version: '5.3.0', name: 'chalk' },
        },
      }, null, 2),
    );

    writeFileSync(
      join(targetDir, 'package.json'),
      JSON.stringify({
        name: '@hostfn/api',
        dependencies: {
          commander: '^12.0.0',
          chalk: '^5.0.0',
        },
      }, null, 2),
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });

  it('prefers workspace-scoped lockfile entries over root-level versions', async () => {
    execSyncMock.mockImplementation(() => {
      const pinnedPackageJson = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8'));
      expect(pinnedPackageJson.dependencies.commander).toBe('12.1.0');
      expect(pinnedPackageJson.dependencies.chalk).toBe('5.3.0');
    });

    const manager = new WorkspaceManager();
    await manager.detectWorkspace(serviceDir);
    await manager.generateLockfile(targetDir, serviceDir);

    expect(execSyncMock).toHaveBeenCalledWith(
      'npm install --package-lock-only --ignore-scripts',
      expect.objectContaining({
        cwd: targetDir,
        stdio: 'ignore',
      }),
    );

    const restoredPackageJson = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8'));
    expect(restoredPackageJson.dependencies.commander).toBe('^12.0.0');
    expect(restoredPackageJson.dependencies.chalk).toBe('^5.0.0');
  });
});
