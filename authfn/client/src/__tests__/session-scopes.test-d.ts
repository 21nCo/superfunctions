import { expectTypeOf, test } from 'vitest';
import type { AuthFnClient, AuthFnSession } from '../index.js';

test('a client session exposes the scopes an authfn 0.6.0+ server sends', () => {
  expectTypeOf<AuthFnSession>().toHaveProperty('scopes').toEqualTypeOf<string[] | undefined>();
  type FetchedSession = NonNullable<Extract<Awaited<ReturnType<AuthFnClient['getSession']>>, { ok: true }>['data']['session']>;
  expectTypeOf<FetchedSession['scopes']>().toEqualTypeOf<string[] | undefined>();
});
