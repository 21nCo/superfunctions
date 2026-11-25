import { describe, expect, it } from 'vitest';
import { errorEnvelope, jsonError, jsonSuccess, resolveRequestId } from '../http/envelopes.js';

describe('authfn envelopes', () => {
  it('preserves authfn-shaped errors from another realm', async () => {
    const request = new Request('https://account.example.com/auth/session');
    const foreignAuthError = {
      code: 'AUTHFN_VALIDATION_ERROR',
      message: 'Email is invalid',
      retryable: false,
      status: 400,
      details: {
        field: 'email'
      }
    };

    const envelope = errorEnvelope('req_cross_realm', foreignAuthError);
    expect(envelope).toEqual({
      ok: false,
      error: {
        code: 'AUTHFN_VALIDATION_ERROR',
        message: 'Email is invalid',
        retryable: false,
        details: {
          field: 'email'
        }
      },
      requestId: 'req_cross_realm'
    });

    const response = jsonError(request, foreignAuthError);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ...envelope,
      requestId: expect.any(String)
    });
  });

  it('falls back to 500 when a foreign authfn-shaped error carries an invalid status', async () => {
    const request = new Request('https://account.example.com/auth/session');
    const response = jsonError(request, {
      code: 'AUTHFN_VALIDATION_ERROR',
      message: 'Email is invalid',
      retryable: false,
      status: 999,
      details: {
        field: 'email'
      }
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'AUTHFN_VALIDATION_ERROR',
        message: 'Email is invalid',
        retryable: false,
        details: {
          field: 'email'
        }
      },
      requestId: expect.any(String)
    });
  });

  it('falls back to 500 when a foreign authfn-shaped error carries a no-body status', async () => {
    const request = new Request('https://account.example.com/auth/session');
    const response = jsonError(request, {
      code: 'AUTHFN_VALIDATION_ERROR',
      message: 'Email is invalid',
      retryable: false,
      status: 204,
      details: {
        field: 'email'
      }
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'AUTHFN_VALIDATION_ERROR',
        message: 'Email is invalid',
        retryable: false,
        details: {
          field: 'email'
        }
      },
      requestId: expect.any(String)
    });
  });

  it('still sanitizes oauth-shaped errors through the mapper', async () => {
    const request = new Request('https://account.example.com/auth/session');
    const response = jsonError(request, {
      code: 'OAUTH_TOKEN_EXCHANGE_FAILED',
      message: 'bearer token exchange failed',
      details: {
        accessToken: 'secret-token'
      }
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'AUTHFN_INTERNAL_ERROR',
        message: 'OAuth token exchange failed',
        retryable: true,
        details: {
          accessToken: '[REDACTED]'
        }
      },
      requestId: expect.any(String)
    });
  });

  it('maps provider-rejected OAuth callback codes to callback-invalid errors', async () => {
    const request = new Request('https://account.example.com/auth/social/callback/google');
    const response = jsonError(request, {
      code: 'OAUTH_TOKEN_EXCHANGE_FAILED',
      message: 'Malformed auth code.',
      status: 400,
      retryable: false,
      details: {
        providerId: 'google',
        grantType: 'authorization_code',
        error: 'invalid_grant'
      }
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'AUTHFN_OAUTH_CALLBACK_INVALID',
        message: 'Malformed auth code.',
        retryable: false,
        details: {
          providerId: 'google',
          grantType: '[REDACTED]',
          error: 'invalid_grant'
        }
      },
      requestId: expect.any(String)
    });
  });

  it('does not expose unknown internal error messages', async () => {
    const request = new Request('https://account.example.com/auth/session');
    const response = jsonError(
      request,
      new Error('Failed query: select * from users where email = $1 params: user@example.com')
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'AUTHFN_INTERNAL_ERROR',
        message: 'Internal authfn error',
        retryable: true,
        details: undefined
      },
      requestId: expect.any(String)
    });
  });

  it('caches an acceptable upstream request id', () => {
    const request = new Request('https://account.example.com/auth/session', {
      headers: { 'x-request-id': 'req_original' }
    });

    expect(resolveRequestId(request)).toBe('req_original');
    request.headers.set('x-request-id', 'req_tampered');
    expect(resolveRequestId(request)).toBe('req_original');
  });

  it('echoes an ordinary upstream id on success and error envelopes', async () => {
    const successRequest = new Request('https://account.example.com/auth/session', {
      headers: { 'x-request-id': 'req_original' }
    });
    const success = jsonSuccess(successRequest, { session: null });
    expect(success.headers.get('x-request-id')).toBe('req_original');
    await expect(success.json()).resolves.toMatchObject({
      ok: true,
      requestId: 'req_original'
    });

    const errorRequest = new Request('https://account.example.com/auth/session', {
      headers: { 'x-request-id': 'req_upstream' }
    });
    const error = jsonError(errorRequest, new Error('Failed query'));
    expect(error.headers.get('x-request-id')).toBe('req_upstream');
    await expect(error.json()).resolves.toMatchObject({
      ok: false,
      requestId: 'req_upstream'
    });
  });

  it('replaces rejected request ids and keeps one generated id on the request', async () => {
    const rejected = ['bad id', 'req\tid', 'x'.repeat(129), 'req_café', '   '];
    for (const value of rejected) {
      const request = new Request('https://account.example.com/auth/session', {
        headers: { 'x-request-id': value }
      });
      const first = resolveRequestId(request);
      expect(first).toMatch(/^req_[0-9a-f]{16}$/);
      expect(first).not.toBe(value.trim());
      request.headers.set('x-request-id', 'req_tampered');
      expect(resolveRequestId(request)).toBe(first);

      const success = jsonSuccess(request, { session: null });
      const failure = jsonError(request, new Error('Failed query'));
      expect(success.headers.get('x-request-id')).toBe(first);
      expect(failure.headers.get('x-request-id')).toBe(first);
      await expect(success.json()).resolves.toMatchObject({ requestId: first });
      await expect(failure.json()).resolves.toMatchObject({ requestId: first });
    }
  });
});
