// Shared test support for authfn plugins that resolve the built `authfn`
// core the way their published package does. It lives in the core package
// directory (not published: core ships only dist) so that editing it changes
// core's hash and reruns every dependent plugin's tests. Only Node built-ins
// are imported: the release build installs a single package without the
// workspace, so nothing here may resolve a package from this directory.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

type Manifest = { version: string; dependencies: Record<string, string> };

const authfnRoot = new URL('../../', import.meta.url);
const workspaceInstalled = (): boolean => existsSync(new URL('../node_modules/authfn', authfnRoot));

/**
 * Vitest global setup body. The tests resolve the built workspace `authfn`,
 * as the published plugin does. Under `turbo run test`, ^build has already
 * built it. A direct `npm test` runs the same ^build through turbo: its cache
 * rebuilds stale or failed output and is a cache hit when current. Node
 * launches turbo's JS entry, so no executable is looked up on PATH. The
 * release build installs only the package, without the workspace, and tests
 * against the published `authfn` it pins, so there is nothing to build.
 */
export function buildWorkspaceCore(packageName: string, packageDir: URL): void {
  if (process.env.TURBO_HASH || !workspaceInstalled()) return;
  const turbo = createRequire(packageDir).resolve('turbo/bin/turbo');
  execFileSync(
    process.execPath,
    [turbo, 'run', 'build', `--filter=${packageName}^...`, '--output-logs=new-only'],
    { cwd: fileURLToPath(new URL('../', authfnRoot)), stdio: 'inherit' }
  );
}

interface VitestApi {
  describe(name: string, body: () => void): void;
  it: {
    runIf(condition: boolean): (name: string, body: () => void) => void;
    skipIf(condition: boolean): (name: string, body: () => void) => void;
  };
  expect(actual: unknown): { toBe(expected: unknown): void };
}

/**
 * Registers the `authfn dependency` checks for the package at `packageDir`.
 * A stale pin installs a nested registry copy of authfn instead, and the
 * plugin then runs without the core fixes released alongside it.
 */
export function describeAuthfnDependency({ describe, it, expect }: VitestApi, packageDir: URL): void {
  describe('authfn dependency', () => {
    const installed = workspaceInstalled();

    it.runIf(installed)('resolves the workspace authfn core', () => {
      const resolved = createRequire(packageDir).resolve('authfn');
      const workspaceCore = fileURLToPath(new URL('core/dist/index.js', authfnRoot));
      expect(realpathSync(resolved)).toBe(realpathSync(workspaceCore));
    });

    // The release build installs only this package, so it tests against the
    // published authfn that the release pins.
    it.skipIf(installed)('resolves the pinned authfn release', () => {
      const manifest = (url: URL): Manifest => JSON.parse(readFileSync(url, 'utf8')) as Manifest;
      const pinned = manifest(new URL('package.json', packageDir)).dependencies.authfn;
      const version = manifest(new URL('node_modules/authfn/package.json', packageDir)).version;
      expect(version).toBe(pinned);
    });
  });
}
