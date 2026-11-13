import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This package re-exports the placement-context issuer, so the core it
// resolves decides which scopes the signed claim carries. An older nested
// core signs every stored API-key scope instead of the registry-grantable ones.
describe('authfn dependency', () => {
  const workspaceInstalled = existsSync(new URL('../../../../node_modules/authfn', import.meta.url));

  it.runIf(workspaceInstalled)('resolves the workspace authfn core', () => {
    const resolved = createRequire(import.meta.url).resolve('authfn');
    const workspaceCore = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
    expect(realpathSync(resolved)).toBe(realpathSync(workspaceCore));
  });

  // The release build installs only this package, so it tests against the
  // published authfn that the release pins.
  it.skipIf(workspaceInstalled)('resolves the pinned authfn release', () => {
    type Manifest = { version: string; dependencies: Record<string, string> };
    const manifest = (url: URL): Manifest => JSON.parse(readFileSync(url, 'utf8')) as Manifest;
    const pinned = manifest(new URL('../../package.json', import.meta.url)).dependencies.authfn;
    const installed = manifest(new URL('../../node_modules/authfn/package.json', import.meta.url)).version;
    expect(installed).toBe(pinned);
  });
});
