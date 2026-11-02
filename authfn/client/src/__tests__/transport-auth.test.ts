import { describe, expect, it, vi } from 'vitest';
import { createTestServer } from './test-server.js';
import {
  createAuthFnTransportAuth
} from '../transport-auth.js';
import { createAuthFnSessionTransportAuth } from '../transport-auth-internal.js';
import { createAuthFnClient } from '../client.js';

describe('createAuthFnTransportAuth', () => {
  it('returns cookie credentials by default', async () => {
    const auth = createAuthFnTransportAuth();

    expect(await auth.getCredentials?.()).toBe('include');
    expect(await auth.getRequestHeaders?.()).toEqual({});
  });

  it('maps configured bearer token and headers into request headers', async () => {
    const auth = createAuthFnSessionTransportAuth({
      bearerToken: async () => ' session-token ',
      headers: () => ({ 'x-custom-auth-context': 'custom' }),
      plugins: [
        {
          getRequestHeaders: () => ({ 'x-plugin-auth-context': 'plugin' })
        }
      ]
    });

    expect(await auth.getRequestHeaders?.()).toEqual({
      authorization: 'Bearer session-token',
      'x-custom-auth-context': 'custom',
      'x-plugin-auth-context': 'plugin'
    });
    expect(await auth.getCredentials?.()).toBe('omit');
  });

  it('keeps explicit bearer-token credential overrides', async () => {
    const auth = createAuthFnSessionTransportAuth({
      bearerToken: 'session-token',
      credentials: 'include'
    });

    expect(await auth.getCredentials?.()).toBe('include');
  });

  it('delegates unauthorized handling when provided', async () => {
    const onUnauthorized = vi.fn(() => 'retry' as const);
    const auth = createAuthFnTransportAuth({ onUnauthorized });
    const event = {
      endpoint: 'pull',
      url: 'https://account.example.com/datafn/pull',
      status: 403,
      result: { ok: false }
    };

    expect(await auth.onUnauthorized?.(event)).toBe('retry');
    expect(onUnauthorized).toHaveBeenCalledWith(event);
  });
  it('sends the CSRF token from the configured cookie prefix for cookie sessions', async () => {
    const auth = createAuthFnSessionTransportAuth({
      cookiePrefix: 'nucleus_local',
      cookieAccessor: () => 'other=1; nucleus_local.csrf=csrf%2Dtoken; authfn.csrf=wrong'
    });

    expect(await auth.getRequestHeaders?.()).toEqual({ 'x-authfn-csrf': 'csrf-token' });
    expect(await auth.getCredentials?.()).toBe('include');
  });

  it('infers the cookie prefix when none is configured', async () => {
    const auth = createAuthFnSessionTransportAuth({
      cookieAccessor: () => 'app.session=s; app.csrf=inferred'
    });

    expect(await auth.getRequestHeaders?.()).toEqual({ 'x-authfn-csrf': 'inferred' });
  });

  it('omits the CSRF header when no CSRF cookie is readable', async () => {
    const auth = createAuthFnSessionTransportAuth({
      cookiePrefix: 'nucleus_local',
      cookieAccessor: () => 'other=1'
    });

    expect(await auth.getRequestHeaders?.()).toEqual({});
  });

  it('sends the CSRF token alongside a bearer token when the cookie is present', async () => {
    const auth = createAuthFnSessionTransportAuth({
      bearerToken: 'session-token',
      cookiePrefix: 'nucleus_local',
      cookieAccessor: () => 'nucleus_local.csrf=csrf-token'
    });

    expect(await auth.getRequestHeaders?.()).toEqual({
      authorization: 'Bearer session-token',
      'x-authfn-csrf': 'csrf-token'
    });
  });

  it('passes client cookie options into transport auth', async () => {
    const client = createAuthFnClient({
      cookiePrefix: 'nucleus_local',
      cookieAccessor: () => 'nucleus_local.csrf=from-client'
    });

    expect(await client.createTransportAuth().getRequestHeaders?.()).toEqual({
      'x-authfn-csrf': 'from-client'
    });
  });
});
