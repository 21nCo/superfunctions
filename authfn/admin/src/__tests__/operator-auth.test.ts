import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import type { AuthFnRuntimeConfig } from 'authfn';
import { createApiKey } from 'authfn/core/api-keys';
import { issueSession } from 'authfn/core/sessions';
import { createUser } from 'authfn/core/users';
import { createAuthFnOperatorAuth, type AuthFnOperatorPrincipal } from '../superconsole.js';

const principal: AuthFnOperatorPrincipal = {
  actor: { type: 'user', id: 'operator' },
  displayName: 'Operator',
  role: 'admin',
  defaultScope: { namespace: 'authfn' }
};

describe('createAuthFnOperatorAuth', () => {
  it('resolves operators only from interactive sessions, never from an API key', async () => {
    const config: AuthFnRuntimeConfig = { database: memoryAdapter({ debug: false }), namespace: 'authfn', plugins: [] };
    const user = await createUser(config, { primaryEmail: 'operator@example.com' });
    const key = await createApiKey(config, { userId: user.id, name: 'operator-cli' });
    const issued = await issueSession(config, {}, { userId: user.id, methods: ['password'] });
    // A host that admits by user ID would admit the owner's key once keys act as their owner.
    const resolveOperator = vi.fn(() => principal);
    const operatorAuth = createAuthFnOperatorAuth({
      config,
      resolveOperator,
      authorizeScope: ({ requested }) => requested
    });
    const request = (secret: string) => new Request('https://console.example.com/admin', {
      headers: { authorization: `Bearer ${secret}` }
    });

    await expect(operatorAuth.authenticate(request(key.secret))).resolves.toBeNull();
    expect(resolveOperator).not.toHaveBeenCalled();

    await expect(operatorAuth.authenticate(request(issued.sessionToken))).resolves.toMatchObject({
      displayName: 'Operator'
    });
    expect(resolveOperator).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ type: 'session', actorId: user.id })
    }));
  });
});
