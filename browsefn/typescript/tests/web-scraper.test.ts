import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowseFnError } from '../src/core/errors.js';
import type {
  GetPageOptions,
  PageResult,
  ProviderCapabilities,
  WebProvider,
} from '../src/core/types.js';
import { WebScraper } from '../src/web/scraper.js';

class MockWebProvider implements WebProvider {
  constructor(
    public name: string,
    public capabilities: ProviderCapabilities,
    private behavior: {
      available?: boolean;
      getPage?: (url: string, options: GetPageOptions) => Promise<PageResult>;
      scrape?: <T>(
        url: string,
        options: GetPageOptions & { script: (page: unknown) => Promise<T> | T }
      ) => Promise<T>;
    } = {}
  ) {}

  async getPage(url: string, options: GetPageOptions): Promise<PageResult> {
    if (this.behavior.getPage) {
      return this.behavior.getPage(url, options);
    }

    return {
      url,
      content: '<html></html>',
      metadata: { url, title: this.name },
      provider: this.name,
      duration: 1,
    };
  }

  async scrape<T>(
    url: string,
    options: GetPageOptions & { script: (page: unknown) => Promise<T> | T }
  ): Promise<T> {
    if (!this.behavior.scrape) {
      throw new Error('scrape not implemented');
    }
    return this.behavior.scrape(url, options);
  }

  async isAvailable(): Promise<boolean> {
    return this.behavior.available ?? true;
  }
}

describe('WebScraper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to a provider that satisfies javascript and screenshot requirements', async () => {
    const scraper = new WebScraper(undefined, undefined, 'cheerio', ['playwright']);
    scraper.registerProvider(
      new MockWebProvider('cheerio', {
        formats: ['html', 'markdown', 'text', 'json'],
        javascript: false,
        screenshots: false,
        cookies: false,
        headers: true,
        selectors: true,
        scriptExecution: false,
      })
    );
    scraper.registerProvider(
      new MockWebProvider(
        'playwright',
        {
          formats: ['html', 'markdown', 'text', 'json'],
          javascript: true,
          screenshots: true,
          cookies: true,
          headers: true,
          selectors: true,
          proxy: true,
          scriptExecution: true,
        },
        {
          getPage: async (url) => ({
            url,
            content: '# Example',
            metadata: { url, title: 'Example Article' },
            links: ['https://example.com/one'],
            images: ['https://example.com/image.png'],
            screenshot: new Uint8Array([1, 2, 3]),
            provider: 'playwright',
            duration: 5,
          }),
        }
      )
    );

    const page = await scraper.getPage('https://example.com/article', {
      provider: 'cheerio',
      format: 'markdown',
      javascript: true,
      screenshot: { fullPage: true, format: 'png' },
      includeLinks: true,
      includeImages: true,
    });

    expect(page.provider).toBe('playwright');
    expect(page.content).toBe('# Example');
    expect(page.links).toEqual(['https://example.com/one']);
    expect(page.images).toEqual(['https://example.com/image.png']);
    expect(page.screenshot).toBeInstanceOf(Uint8Array);
  });

  it('returns a structured capability error when no provider can satisfy the request', async () => {
    const scraper = new WebScraper(undefined, undefined, 'cheerio');
    scraper.registerProvider(
      new MockWebProvider('cheerio', {
        formats: ['html', 'markdown', 'text', 'json'],
        javascript: false,
        screenshots: false,
        cookies: false,
        headers: true,
        selectors: true,
        scriptExecution: false,
      })
    );

    await expect(
      scraper.getPage('https://example.com/article', {
        provider: 'cheerio',
        javascript: true,
        screenshot: true,
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
      message:
        'Provider cheerio cannot satisfy javascript or screenshot requirements.',
    });
  });

  it('preserves input order, filters fields, and reports monotonic progress', async () => {
    const scraper = new WebScraper();
    const progressCalls: Array<[number, number]> = [];

    scraper.registerProvider(
      new MockWebProvider(
        'playwright',
        {
          formats: ['html', 'markdown', 'text', 'json'],
          javascript: true,
          screenshots: true,
          cookies: true,
          headers: true,
          selectors: true,
          proxy: true,
          scriptExecution: true,
        },
        {
          getPage: async (url) => {
            if (url.endsWith('/a')) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return {
                url,
                content: '<html>A</html>',
                metadata: {
                  url,
                  title: 'A',
                  description: 'Alpha',
                  image: 'https://example.com/a.png',
                },
                provider: 'playwright',
              };
            }

            return {
              url,
              content: '<html>B</html>',
              metadata: {
                url,
                title: 'B',
                description: 'Beta',
                image: 'https://example.com/b.png',
              },
              provider: 'playwright',
            };
          },
        }
      )
    );

    const results = await scraper.getMultipleMetadata(
      ['https://example.com/a', 'https://example.com/b'],
      {
        fields: ['title', 'description'],
        concurrency: 2,
        onProgress: (completed, total) => {
          progressCalls.push([completed, total]);
        },
      }
    );

    expect(results).toEqual([
      {
        success: true,
        data: {
          url: 'https://example.com/a',
          title: 'A',
          description: 'Alpha',
        },
        provider: 'playwright',
        cached: undefined,
        duration: expect.any(Number),
      },
      {
        success: true,
        data: {
          url: 'https://example.com/b',
          title: 'B',
          description: 'Beta',
        },
        provider: 'playwright',
        cached: undefined,
        duration: expect.any(Number),
      },
    ]);
    expect(progressCalls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('returns one result per URL even when a batch item fails', async () => {
    const scraper = new WebScraper();
    scraper.registerProvider(
      new MockWebProvider(
        'cheerio',
        {
          formats: ['html', 'markdown', 'text', 'json'],
          javascript: false,
          screenshots: false,
          cookies: false,
          headers: true,
          selectors: true,
          scriptExecution: false,
        },
        {
          getPage: async (url) => {
            if (url.endsWith('/bad')) {
              throw new Error('boom');
            }
            return {
              url,
              content: '<html>ok</html>',
              metadata: { url, title: 'ok' },
              provider: 'cheerio',
            };
          },
        }
      )
    );

    const results = await scraper.getMultipleMetadata([
      'https://example.com/good',
      'https://example.com/bad',
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1]).toEqual({
      success: false,
      error: 'boom',
    });
  });

  it('rejects oversized metadata batches with a structured validation error', async () => {
    const scraper = new WebScraper();

    await expect(
      scraper.getMultipleMetadata(
        [
          'https://example.com/1',
          'https://example.com/2',
          'https://example.com/3',
        ],
        {
          concurrency: 3,
          maxBatchOverride: 2,
        }
      )
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Metadata batch size exceeds the configured maximum.',
    });
  });

  it('rejects unsupported custom scrape providers deterministically', async () => {
    const scraper = new WebScraper(undefined, undefined, 'cheerio');
    scraper.registerProvider(
      new MockWebProvider('cheerio', {
        formats: ['html', 'markdown', 'text', 'json'],
        javascript: false,
        screenshots: false,
        cookies: false,
        headers: true,
        selectors: true,
        scriptExecution: false,
      })
    );

    await expect(
      scraper.scrape('https://example.com/product', {
        provider: 'cheerio',
        script: () => ({ title: 'ignored' }),
      })
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER_CAPABILITY',
      message: 'Provider cheerio cannot execute custom scrape scripts.',
    });
  });
});

it.each([
  [undefined, true], [[], false], [['TIMEOUT'], true], [['RATE_LIMIT'], false],
] as [string[] | undefined, boolean][])('honors fallback policy %j', async (policy, allowed) => {
  const scraper = new WebScraper(undefined, undefined, 'a', ['b'], undefined, policy);
  const capabilities = { formats: ['html'] as ['html'], javascript: false, screenshots: false, cookies: false, headers: true, selectors: false };
  const second = vi.fn(async (url: string) => ({ url, content: 'ok', metadata: { url }, provider: 'b', duration: 0 }));
  scraper.registerProvider(new MockWebProvider('a', capabilities, { getPage: async () => { throw new BrowseFnError({ code: 'UPSTREAM_TIMEOUT', message: 'timeout' }); } }));
  scraper.registerProvider(new MockWebProvider('b', capabilities, { getPage: second }));
  if (allowed) expect((await scraper.getPage('https://example.com')).content).toBe('ok');
  else await expect(scraper.getPage('https://example.com')).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  expect(second).toHaveBeenCalledTimes(allowed ? 1 : 0);
});
