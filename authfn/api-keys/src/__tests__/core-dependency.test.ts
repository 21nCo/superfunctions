import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('authfn dependency', () => {
  // A stale pin installs a nested registry copy of authfn instead, and the
  // plugin then runs without the core fixes released alongside it.
  it('resolves the workspace authfn core', () => {
    const resolved = createRequire(import.meta.url).resolve('authfn');
    const workspaceCore = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
    expect(realpathSync(resolved)).toBe(realpathSync(workspaceCore));
  });
});
