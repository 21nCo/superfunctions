import { describe, expect, it, vi } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';

// Records the cost of each scrypt job in the order sign-in queues them.
const started = vi.hoisted(() => [] as number[]);
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    scrypt: ((...args: unknown[]) => {
      const options = args[3] as { N?: number } | undefined;
      started.push(options?.N ?? 0);
      return (actual.scrypt as (...rest: unknown[]) => void)(...args);
    }) as typeof actual.scrypt
  };
});

import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnPasswordPlugin } from '@authfn/password';
import type { AuthFnRuntimeConfig } from '../index.js';
import { createUser } from '../core/users.js';
import { createPasswordCredential, signInWithPassword, updatePasswordCredential } from '../core/passwords.js';

function legacyHash(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url');
  return ['scrypt', '16384', '8', '1', salt, digest].join('$');
}

describe('sign-in scrypt job order (AF-10)', () => {
  it('queues the current-cost job first for every kind of account', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [authFnPasswordPlugin()]
    };
    const legacy = await createUser(config, { primaryEmail: 'legacy@example.com' });
    await createPasswordCredential(config, { userId: legacy.id, passwordHash: legacyHash('test-password-legacy') });
    const current = await createUser(config, { primaryEmail: 'current@example.com' });
    await updatePasswordCredential(config, { userId: current.id, password: 'test-password-current' });
    await createUser(config, { primaryEmail: 'nopassword@example.com' });

    const orders: Record<string, number[]> = {};
    for (const email of ['legacy@example.com', 'current@example.com', 'nopassword@example.com', 'nobody@example.com']) {
      started.length = 0;
      await expect(signInWithPassword(config, { email, password: 'test-password-wrong' }))
        .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
      orders[email] = [...started];
    }
    for (const order of Object.values(orders)) {
      expect(order).toEqual([32768, 16384]);
    }
  });
});
