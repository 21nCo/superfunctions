import { describe, expect, it, vi } from 'vitest';
import { PlaywrightProvider } from '../src/web/providers/playwright.js';
import { PuppeteerProvider } from '../src/web/providers/puppeteer.js';

for (const kind of ['playwright', 'puppeteer'] as const) {
  function setup() {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined), url: () => 'https://redirect.example/final/page',
      content: vi.fn().mockResolvedValue('<html><a href="relative">Link</a><img src="image.png"></html>'),
      authenticate: vi.fn(), setExtraHTTPHeaders: vi.fn(), setCookie: vi.fn(),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page), addCookies: vi.fn() };
    const browser = { newContext: vi.fn().mockResolvedValue(context), newPage: context.newPage, close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);
    const provider = kind === 'playwright' ? new PlaywrightProvider() : new PuppeteerProvider();
    (provider as any)[kind] = kind === 'playwright' ? { chromium: { launch } } : { launch };
    return { page, browser, launch, provider };
  }
  describe(kind, () => {
    it('uses proxy credentials and resolves resources against the final navigation URL', async () => {
      const { provider, page, launch } = setup();
      const result = await provider.getPage('https://start.example', {
        proxy: 'http://user:p%40ss@proxy.example:8080', includeLinks: true, includeImages: true,
      });
      expect(result.url).toBe('https://redirect.example/final/page');
      expect(result.links).toEqual(['https://redirect.example/final/relative']);
      expect(result.images).toEqual(['https://redirect.example/final/image.png']);
      if (kind === 'playwright') expect(launch).toHaveBeenCalledWith(expect.objectContaining({
        proxy: { server: 'http://proxy.example:8080', username: 'user', password: 'p@ss' },
      }));
      else {
        expect(launch.mock.calls[0][0].args).toContain('--proxy-server=http://proxy.example:8080');
        expect(page.authenticate).toHaveBeenCalledWith({ username: 'user', password: 'p@ss' });
      }
    });
    it('keeps the browser open until asynchronous extraction finishes', async () => {
      const { provider, browser } = setup();
      let resume!: () => void;
      const pause = new Promise<void>(resolve => { resume = resolve; });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const result = provider.scrape('https://example.com', { script: async () => { entered(); await pause; return 'done'; } });
      await started;
      expect(browser.close).not.toHaveBeenCalled();
      resume();
      expect(await result).toBe('done');
      expect(browser.close).toHaveBeenCalledTimes(1);
    });
    it('preserves extraction errors when browser cleanup also fails', async () => {
      const { provider, browser } = setup();
      browser.close.mockRejectedValue(new Error('close failed'));
      await expect(provider.scrape('https://example.com', { script: async () => { throw new Error('extraction failed'); } })).rejects.toThrow('extraction failed');
      expect(browser.close).toHaveBeenCalledTimes(1);
    });
    it('reports cleanup failure if extraction succeeded', async () => {
      const { provider, browser } = setup();
      browser.close.mockRejectedValue(new Error('close failed'));
      await expect(provider.scrape('https://example.com', { script: () => 'ok' })).rejects.toThrow('close failed');
    });
  });
}
