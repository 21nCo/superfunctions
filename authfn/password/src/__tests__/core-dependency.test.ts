import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuthFnRuntimeConfig } from 'authfn';
// Resolved the way the published plugin resolves it: no source aliases, so
// this is the built `authfn` that `@authfn/password` depends on.
import { signUpWithPassword } from 'authfn/core/passwords';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';

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

  it('reports a sign-up that loses the email to a concurrent sign-up as a conflict', async () => {
    const database = memoryAdapter({ debug: false });
    const config: AuthFnRuntimeConfig = {
      namespace: 'authfn',
      plugins: [],
      database: {
        ...database,
        create: async (params) => {
          if (params.model === 'users') {
            // A concurrent sign-up lands first; the unique index rejects this row.
            await database.create({ ...params, data: { ...params.data, id: 'user_winner' } });
            throw new Error('UNIQUE constraint failed: authfn_users.primary_email');
          }
          return database.create(params);
        }
      }
    };

    await expect(
      signUpWithPassword(config, {}, { email: 'race@example.com', password: 'correct horse battery staple' })
    ).rejects.toMatchObject({ code: 'AUTHFN_CONFLICT', status: 409 });
  });
});
