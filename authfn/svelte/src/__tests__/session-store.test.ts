import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { createAuthFnSessionStore } from '../session-store.js';

describe('@authfn/svelte session store', () => {
  it('wraps client.getSession without reimplementing auth logic', async () => {
    const calls: string[] = [];
    const store = createAuthFnSessionStore({
      async getSession() {
        calls.push('getSession');
        return {
          ok: true,
          data: {
            session: {
              id: 'sess_01',
              type: 'session',
              subject: {
                actorId: 'user_01',
                actorType: 'user',
                email: 'ada@example.com'
              },
              actorType: 'user',
              actorId: 'user_01',
              resourceIds: [],
              methods: ['password'],
              primaryEmail: 'ada@example.com'
            }
          },
          requestId: 'req_01'
        };
      }
    } as any);

    await store.refresh();

    expect(get(store)).toMatchObject({
      id: 'sess_01',
      primaryEmail: 'ada@example.com',
      methods: ['password']
    });
    expect(calls).toEqual(['getSession', 'getSession']);
  });

  it('clears the store and treats client errors as empty session state', async () => {
    const responses = [
      Promise.resolve({
        ok: false,
        error: {
          code: 'AUTHFN_UNAUTHENTICATED',
          message: 'Authentication required',
          retryable: false
        },
        requestId: 'req_02'
      }),
      Promise.resolve({
        ok: false,
        error: {
          code: 'AUTHFN_UNAUTHENTICATED',
          message: 'Authentication required',
          retryable: false
        },
        requestId: 'req_02'
      })
    ];

    const store = createAuthFnSessionStore({
      async getSession() {
        return responses.shift()!;
      }
    } as any);

    await store.refresh();
    expect(get(store)).toBeNull();

    store.clear();
    expect(get(store)).toBeNull();
  });
});
