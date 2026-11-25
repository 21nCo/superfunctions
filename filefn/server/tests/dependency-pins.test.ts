import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const serverRequire = createRequire(join(repoRoot, 'filefn/server/package.json'));

describe('server dependency pins (F-20)', () => {
  it.each([
    ['@superfunctions/db', 'packages/db'],
    ['@superfunctions/middleware', 'packages/middleware'],
    ['@filefn/processing', 'filefn/processing'],
  ])('resolves %s from its workspace at %s', (name, workspace) => {
    expect(serverRequire.resolve(name)).toBe(realpathSync(join(repoRoot, workspace, 'dist/index.js')));
  });
});
