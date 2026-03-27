import { describe, expect, it } from 'vitest';
import { assertValidRouteMeta, parseCookieHeader, parseCookies, serializeSetCookie } from '../cookies.js';

describe('cookie helpers', () => {
  it('serializes secure httpOnly cookies deterministically', () => {
    expect(
      serializeSetCookie({
        name: '__Secure-authfn.session',
        value: 'opaque_1',
      })
    ).toBe('__Secure-authfn.session=opaque_1; Path=/; Secure; HttpOnly; SameSite=Lax');
  });

  it('supports non-httpOnly cookies while preserving attribute order', () => {
    expect(
      serializeSetCookie({
        name: 'authfn.csrf',
        value: 'csrf_1',
        httpOnly: false,
      })
    ).toBe('authfn.csrf=csrf_1; Path=/; Secure; SameSite=Lax');
  });

  it('rejects invalid sameSite values with HTTP_META_INVALID', () => {
    try {
      serializeSetCookie({
        name: 'bad-cookie',
        value: 'x',
        sameSite: 'invalid' as never,
      });
      throw new Error('Expected invalid sameSite error');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'BadRequestError',
        code: 'HTTP_META_INVALID',
        statusCode: 400,
      });
    }
  });

  it('parses cookie headers and request cookies deterministically', () => {
    const header = '__Secure-authfn.session=opaque_1; authfn.csrf=csrf_1; encoded=hello%20world';
    expect(parseCookieHeader(header)).toEqual({
      '__Secure-authfn.session': 'opaque_1',
      'authfn.csrf': 'csrf_1',
      encoded: 'hello world',
    });

    const request = new Request('http://localhost', {
      headers: { cookie: header },
    });
    expect(parseCookies(request)).toEqual({
      '__Secure-authfn.session': 'opaque_1',
      'authfn.csrf': 'csrf_1',
      encoded: 'hello world',
    });
  });

  it('validates typed route metadata for auth and openapi usage', () => {
    expect(() =>
      assertValidRouteMeta({
        auth: {
          mode: 'cookie-session',
          csrf: true,
        },
        openapi: {
          operationId: 'getSession',
          summary: 'Read the current session',
        },
      })
    ).not.toThrow();

    try {
      assertValidRouteMeta({
        auth: {
          mode: 'unsupported',
        },
      });
      throw new Error('Expected invalid route metadata error');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'BadRequestError',
        code: 'HTTP_META_INVALID',
        statusCode: 400,
      });
    }
  });
});
