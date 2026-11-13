import { describe, expect, it } from 'vitest';
import { createAuthFnClient } from '../index.js';

describe('@authfn/client session scopes', () => {
  it('returns the scopes the server sends on the session', async () => {
    const client = createAuthFnClient({
      baseUrl: 'https://account.example.com/auth',
      fetch: async () => Response.json({
        ok: true,
        data: {
          session: {
            id: 'ses_1',
            type: 'session',
            subject: { actorId: 'usr_1', actorType: 'user' },
            actorType: 'user',
            actorId: 'usr_1',
            resourceIds: [],
            methods: ['password'],
            scopes: ['*']
          }
        },
        requestId: 'req_1'
      })
    });

    const result = await client.getSession();
    expect(result.ok && result.data.session?.scopes).toEqual(['*']);
  });
});
