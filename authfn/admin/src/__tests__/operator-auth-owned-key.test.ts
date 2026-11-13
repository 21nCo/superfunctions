import { describe, expect, it, vi } from 'vitest';
import type { AuthFnRuntimeConfig, AuthFnSession } from 'authfn';

// @authfn/admin resolves authfn from npm; stub the provider so the guard is
// checked against the authfn 0.5.0 owned-key session shape directly.
const stubSession = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('authfn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('authfn')>();
  return {
    ...actual,
    authfn: () => ({
      createServer: () => ({
        provider: { authenticate: async () => stubSession.current }
      })
    })
  };
});

const { createAuthFnOperatorAuth } = await import('../superconsole.js');

const ownedKeySession = {
  id: 'key_owned',
  type: 'api-key',
  subject: { actorId: 'user_operator', actorType: 'user' },
  actorId: 'user_operator',
  actorType: 'user',
  credential: { type: 'api-key', id: 'key_owned' },
  resourceIds: [],
  methods: ['api-key'],
  metadata: { ownerUserId: 'user_operator', scopes: [] }
} as unknown as AuthFnSession;

describe('createAuthFnOperatorAuth with an owned-key session', () => {
  it('rejects a session whose actor is the operator user when an API key authenticated it', async () => {
    stubSession.current = ownedKeySession;
    const resolveOperator = vi.fn(() => ({
      actor: { type: 'user' as const, id: 'user_operator' },
      displayName: 'Operator',
      role: 'admin',
      defaultScope: { namespace: 'authfn' }
    }));
    const operatorAuth = createAuthFnOperatorAuth({
      config: { namespace: 'authfn', plugins: [] } as unknown as AuthFnRuntimeConfig,
      resolveOperator,
      authorizeScope: ({ requested }) => requested
    });

    await expect(operatorAuth.authenticate(new Request('https://console.example.com/admin', {
      headers: { authorization: 'Bearer ak_owned' }
    }))).resolves.toBeNull();
    expect(resolveOperator).not.toHaveBeenCalled();
  });
});
