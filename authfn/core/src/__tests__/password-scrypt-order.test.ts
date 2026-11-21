import { describe, expect, it, vi } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';

// Records the cost of each scrypt job in the order sign-in queues them.
const started = vi.hoisted(() => [] as number[]);
// While `hold.fake`, jobs answer a zero digest instead of hashing; while
// `hold.on` they also wait, until a test runs the callbacks in `hold.pending`.
const hold = vi.hoisted(() => ({ on: false, fake: false, pending: [] as Array<() => void> }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    scrypt: ((...args: unknown[]) => {
      const options = args[3] as { N?: number } | undefined;
      started.push(options?.N ?? 0);
      if (hold.fake) {
        const keyLength = args[2] as number;
        const callback = args[args.length - 1] as (error: Error | null, derived: Buffer) => void;
        const answer = () => setImmediate(() => callback(null, Buffer.alloc(keyLength)));
        if (hold.on) {
          hold.pending.push(answer);
        } else {
          answer();
        }
        return;
      }
      return (actual.scrypt as (...rest: unknown[]) => void)(...args);
    }) as typeof actual.scrypt
  };
});

import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnPasswordPlugin } from '@authfn/password';
import type { AuthFnRuntimeConfig } from '../index.js';
import { createUser } from '../core/users.js';
import { createPasswordCredential, hashPassword, signInWithPassword, updatePasswordCredential } from '../core/passwords.js';

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

  it('refuses an oversized or non-string password before any scrypt job, for every email', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [authFnPasswordPlugin()]
    };
    const user = await createUser(config, { primaryEmail: 'known@example.com' });
    await updatePasswordCredential(config, { userId: user.id, password: 'test-password-current' });
    const refused: unknown[] = ['x'.repeat(64 * 1024 + 1), { length: 1 }, ['x'], 123, true];
    for (const email of ['known@example.com', 'nobody@example.com']) {
      for (const password of refused) {
        started.length = 0;
        await expect(signInWithPassword(config, { email, password: password as string }))
          .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
        expect(started).toEqual([]);
      }
    }
    started.length = 0;
    await expect(signInWithPassword(config, { email: `${'a'.repeat(400)}@example.com`, password: 'test-password-wrong' }))
      .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
    expect(started).toEqual([]);
  });

  it('refuses a sign-in whose two jobs do not both fit, without queuing either', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [authFnPasswordPlugin()]
    };
    await createUser(config, { primaryEmail: 'busy@example.com' });
    hold.fake = true;
    hold.on = true;
    started.length = 0;
    // 16 running and 1023 queued: one queue slot is left.
    const filler = Array.from({ length: 16 + 1023 }, () => hashPassword('test-password-filler').catch(() => undefined));
    await expect(signInWithPassword(config, { email: 'busy@example.com', password: 'test-password-wrong' }))
      .rejects.toMatchObject({ code: 'AUTHFN_RATE_LIMITED' });
    hold.on = false;
    while (hold.pending.length > 0) {
      hold.pending.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(filler);
    hold.fake = false;
    // Only the filler jobs ran: the refused sign-in queued nothing.
    expect(started.length).toBe(16 + 1023);
  }, 120_000);
});
