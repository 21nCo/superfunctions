import { afterEach, describe, expect, it, vi } from 'vitest';

const puppeteerLaunchMock = vi.hoisted(() => vi.fn());
const playwrightLaunchMock = vi.hoisted(() => vi.fn());

vi.mock('puppeteer', () => ({
  launch: puppeteerLaunchMock,
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: playwrightLaunchMock,
  },
  firefox: {
    launch: playwrightLaunchMock,
  },
  webkit: {
    launch: playwrightLaunchMock,
  },
}));

import { FirecrawlProvider } from '../src/web/providers/firecrawl.js';
import { JinaProvider } from '../src/web/providers/jina.js';
import { PlaywrightProvider } from '../src/web/providers/playwright.js';
import { PuppeteerProvider } from '../src/web/providers/puppeteer.js';

describe('Web providers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    puppeteerLaunchMock.mockReset();
    playwrightLaunchMock.mockReset();
  });

  it('normalizes Firecrawl responses into canonical page results', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            html: '<html><body><a href="/docs">Docs</a><img src="/image.png" /></body></html>',
            markdown: '# Example',
            links: ['https://example.com/docs'],
            images: ['https://example.com/image.png'],
            metadata: {
              title: 'Example',
              description: 'Alpha',
            },
          },
        }),
      } as Response);

    const provider = new FirecrawlProvider({ apiKey: 'test-key' });
    const result = await provider.getPage('https://example.com/article', {
      format: 'markdown',
      includeLinks: true,
      includeImages: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('firecrawl');
    expect(result.content).toBe('# Example');
    expect(result.metadata.title).toBe('Example');
    expect(result.links).toEqual(['https://example.com/docs']);
    expect(result.images).toEqual(['https://example.com/image.png']);
    expect(result.screenshot).toBeUndefined();
  });

  it('returns markdown content through the Jina provider contract', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { html: '<h1>Example Product</h1><p>Price: $10.00</p>' } }),
    } as Response);

    const provider = new JinaProvider({ apiKey: 'test-key' });
    const result = await provider.getPage('https://example.com/product', {
      format: 'markdown',
    });

    expect(result.provider).toBe('jina');
    expect(result.content).toContain('Example Product');
    expect(result.url).toBe('https://example.com/product');
  });

  it('executes custom scrape scripts with Puppeteer providers', async () => {
    const page = {
      marker: 'puppeteer-page',
      url: () => 'https://example.com/product',
      setExtraHTTPHeaders: vi.fn(),
      setCookie: vi.fn(),
      setViewport: vi.fn(),
      goto: vi.fn(),
      setJavaScriptEnabled: vi.fn(),
      screenshot: vi.fn(),
      content: vi.fn().mockResolvedValue('<html></html>'),
      evaluate: vi.fn(),
    };
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn(),
    };
    puppeteerLaunchMock.mockResolvedValue(browser);

    const provider = new PuppeteerProvider();
    const result = await provider.scrape('https://example.com/product', {
      provider: 'puppeteer',
      javascript: false,
      script: async (runtimePage: any) => ({
        title: 'Example Product',
        runtime: runtimePage.marker,
      }),
    });

    expect(result).toEqual({
      title: 'Example Product',
      runtime: 'puppeteer-page',
    });
    expect(page.setJavaScriptEnabled).toHaveBeenCalledWith(false);
    expect(page.setJavaScriptEnabled.mock.invocationCallOrder[0]).toBeLessThan(page.goto.mock.invocationCallOrder[0]);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('executes custom scrape scripts with Playwright providers', async () => {
    const page = {
      marker: 'playwright-page',
      url: () => 'https://example.com/product',
      goto: vi.fn(),
      screenshot: vi.fn(),
      content: vi.fn().mockResolvedValue('<html></html>'),
      evaluate: vi.fn(),
    };
    const context = {
      addCookies: vi.fn(),
      newPage: vi.fn().mockResolvedValue(page),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn(),
    };
    playwrightLaunchMock.mockResolvedValue(browser);

    const provider = new PlaywrightProvider();
    const result = await provider.scrape('https://example.com/product', {
      provider: 'playwright',
      javascript: false,
      script: (runtimePage: any) => ({
        title: 'Example Product',
        runtime: runtimePage.marker,
        price: '$10.00',
      }),
    });

    expect(result).toEqual({
      title: 'Example Product',
      runtime: 'playwright-page',
      price: '$10.00',
    });
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ javaScriptEnabled: false }));
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
