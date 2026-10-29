import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuthFnRuntimeConfig } from 'authfn';
// Resolved the way the published plugin resolves it: no source aliases, so
// this is the built `authfn` that `@authfn/password` depends on.
import { signUpWithPassword } from 'authfn/core/passwords';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';

describe('authfn dependency', () => {
  it('resolves the workspace authfn core', () => {
    const resolved = createRequire(import.meta.url).resolve('authfn');
    const workspaceCore = fileURLToPath(new URL('../../../core/dist/index.js', import.meta.url));
    expect(realpathSync(resolved)).toBe(realpathSync(workspaceCore));
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
