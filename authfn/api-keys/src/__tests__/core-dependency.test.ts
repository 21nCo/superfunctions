import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('authfn dependency', () => {
  // A stale pin installs a nested registry copy of authfn instead, and the
  // plugin then runs without the core fixes released alongside it.
  const workspaceInstalled = existsSync(new URL('../../../../node_modules/authfn', import.meta.url));

  it.runIf(workspaceInstalled)('resolves the workspace authfn core', () => {
    const resolved = createRequire(import.meta.url).resolve('authfn');
    const workspaceCore = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
    expect(realpathSync(resolved)).toBe(realpathSync(workspaceCore));
  });

  // The release build installs only this package, so it tests against the
  // published authfn that the release pins.
  it.skipIf(workspaceInstalled)('resolves the pinned authfn release', () => {
    const manifest = (url: URL) => JSON.parse(readFileSync(url, 'utf8'));
    const pinned = manifest(new URL('../../package.json', import.meta.url)).dependencies.authfn;
    const installed = manifest(new URL('../../node_modules/authfn/package.json', import.meta.url)).version;
    expect(installed).toBe(pinned);
  });
});
