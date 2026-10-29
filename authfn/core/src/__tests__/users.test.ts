import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import type { AuthFnRuntimeConfig } from '../index.js';
import { createUser } from '../core/users.js';

function createConfig(): AuthFnRuntimeConfig {
  return {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: []
  };
}

describe('createUser', () => {
  it('reports an email claimed between the existence check and the insert as a conflict', async () => {
    const config = createConfig();
    const database = config.database;
    config.database = {
      ...database,
      create: async (params) => {
        // A concurrent sign-up lands first; the unique index rejects this row.
        await database.create({
          ...params,
          data: { ...params.data, id: 'user_winner' }
        });
        throw new Error('UNIQUE constraint failed: authfn_users.primary_email');
      }
    };

    await expect(createUser(config, { primaryEmail: 'Race@Example.com' })).rejects.toMatchObject({
      code: 'AUTHFN_CONFLICT',
      status: 409,
      details: { primaryEmail: 'race@example.com', emailExists: true }
    });
  });

  it('rethrows an insert failure when the email is still free', async () => {
    const config = createConfig();
    const failure = new Error('disk I/O error');
    config.database = {
      ...config.database,
      create: async () => {
        throw failure;
      }
    };

    await expect(createUser(config, { primaryEmail: 'owner@example.com' })).rejects.toBe(failure);
    await expect(createUser(config, {})).rejects.toBe(failure);
  });
});
