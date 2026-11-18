import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authfn, type AuthFnRuntimeConfig } from 'authfn';
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

const consoleUrl = 'https://console.example.com/admin';

// No stub: the workspace authfn core authenticates the key, so the owned-key
// session shape is whatever the current core produces.
describe('createAuthFnOperatorAuth with an owned API key from the current core', () => {
  it('rejects the owned key before resolveOperator and still resolves the owner\'s cookie session', async () => {
    const config: AuthFnRuntimeConfig = { database: memoryAdapter({ debug: false }), namespace: 'authfn', plugins: [] };
    const user = await createUser(config, { primaryEmail: 'operator@example.com' });
    const key = await createApiKey(config, { userId: user.id, name: 'operator-cli' });
    const keyRequest = () => new Request(consoleUrl, { headers: { authorization: `Bearer ${key.secret}` } });

    // The core accepts the owned key as its owner, so only the operator guard keeps it out.
    const core = authfn(config).createServer(config);
    await expect(core.provider.authenticate(keyRequest())).resolves.toMatchObject({
      type: 'api-key',
      actorId: user.id,
      credential: { type: 'api-key', id: key.keyId }
    });

    const resolveOperator = vi.fn(() => principal);
    const operatorAuth = createAuthFnOperatorAuth({
      config,
      resolveOperator,
      authorizeScope: ({ requested }) => requested
    });

    await expect(operatorAuth.authenticate(keyRequest())).resolves.toBeNull();
    expect(resolveOperator).not.toHaveBeenCalled();

    const issued = await issueSession(config, {}, { userId: user.id, methods: ['password'] });
    const { sessionCookieName, csrfCookieName } = await core.cookieNamesForRequest(new Request(consoleUrl));
    const cookieRequest = new Request(consoleUrl, {
      headers: { cookie: `${sessionCookieName}=${issued.sessionToken}` }
    });

    await expect(operatorAuth.authenticate(cookieRequest)).resolves.toMatchObject({
      displayName: 'Operator',
      authentication: { csrfCookieName }
    });
    expect(resolveOperator).toHaveBeenCalledOnce();
    expect(resolveOperator).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ type: 'session', actorId: user.id })
    }));
  });
});
