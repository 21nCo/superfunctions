import { describe, expect, it } from 'vitest';

import { BROWSEFN_RESULT_META_KEY } from '../src/core/browse-fn.js';
import { createBrowseFnRouter } from '../src/router/http-router.js';

describe('BrowseFn router smoke', () => {
  it('returns the canonical success envelope for /web/page', async () => {
    const router = createBrowseFnRouter({
      web: {
        getPage: async (url: string) => ({
          url,
          content: 'body',
          metadata: {
            url,
            title: 'Example',
          },
          provider: 'cheerio',
          screenshot: new Uint8Array([1, 2, 3]),
          cached: false,
          duration: 12,
          [BROWSEFN_RESULT_META_KEY]: {
            provider: 'cheerio',
            cached: false,
            durationMs: 12,
          },
        }),
      },
      images: null,
      geo: null,
      getMetrics: async () => null,
    } as never);

    const response = await router.handle(
      new Request('http://localhost/web/page', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-router-smoke',
        },
        body: JSON.stringify({
          url: 'https://example.com/article',
          options: { format: 'html' },
        }),
      })
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: {
        url: 'https://example.com/article',
        provider: 'cheerio',
        screenshot: Buffer.from([1, 2, 3]).toString('base64'),
      },
      meta: {
        requestId: 'req-router-smoke',
        provider: 'cheerio',
        cached: false,
        durationMs: 12,
      },
    });
  });

  it('returns the canonical error envelope for invalid requests', async () => {
    const router = createBrowseFnRouter({
      web: {
        getPage: async () => {
          throw new Error('should not be called');
        },
      },
      images: null,
      geo: null,
      getMetrics: async () => null,
    } as never);

    const response = await router.handle(
      new Request('http://localhost/web/page', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-router-error',
        },
        body: JSON.stringify({}),
      })
    );

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'Missing required field: url',
      },
      meta: {
        requestId: 'req-router-error',
      },
    });
  });
});
