/**
 * Playwright provider for cross-browser scraping.
 */

import type {
  GetPageOptions,
  ProviderCapabilities,
  WebProvider,
} from '../../core/types.js';
import { sanitizeUrl } from '../../utils/validation.js';
import {
  BROWSER_PROVIDER_CAPABILITIES,
  buildBrowserPageResult,
  isProviderModuleAvailable,
} from './browser-provider-utils.js';

type PlaywrightPage = {
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  screenshot(options: {
    fullPage?: boolean;
    type?: 'png' | 'jpeg';
    quality?: number;
  }): Promise<Uint8Array>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
};

type PlaywrightContext = {
  addCookies(cookies: Array<{ name: string; value: string; domain: string; path: string }>): Promise<void>;
  newPage(): Promise<PlaywrightPage>;
};

type PlaywrightBrowser = {
  newContext(options: {
    extraHTTPHeaders?: Record<string, string>;
    javaScriptEnabled?: boolean;
    userAgent?: string;
    viewport?: { width: number; height: number };
  }): Promise<PlaywrightContext>;
  close(): Promise<void>;
};

type PlaywrightBrowserType = {
  launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
};

type PlaywrightModule = Record<'chromium' | 'firefox' | 'webkit', PlaywrightBrowserType>;

export class PlaywrightProvider implements WebProvider {
  name = 'playwright';

  capabilities: ProviderCapabilities = BROWSER_PROVIDER_CAPABILITIES;

  private playwright?: PlaywrightModule;

  constructor(
    private config: {
      browser?: 'chromium' | 'firefox' | 'webkit';
      headless?: boolean;
      timeout?: number;
    } = {}
  ) {}

  async getPage(url: string, options: GetPageOptions = {}) {
    return this.withPage(url, options, (page, sanitizedUrl, startedAt) =>
      buildBrowserPageResult({
        page,
        options,
        sanitizedUrl,
        provider: this.name,
        startedAt,
      })
    );
  }

  async scrape<T>(
    url: string,
    options: GetPageOptions & { script: (page: unknown) => Promise<T> | T }
  ): Promise<T> {
    return this.withPage(url, options, async (page) => options.script(page));
  }

  async isAvailable(): Promise<boolean> {
    return isProviderModuleAvailable(() => this.loadPlaywright());
  }

  private async withPage<T>(
    url: string,
    options: GetPageOptions,
    callback: (page: PlaywrightPage, sanitizedUrl: string, startedAt: number) => Promise<T>
  ): Promise<T> {
    const playwright = await this.loadPlaywright();
    const startedAt = Date.now();
    const sanitizedUrl = sanitizeUrl(url);

    const browserType = this.config.browser || 'chromium';
    const browser = await playwright[browserType].launch({
      headless: this.config.headless ?? true,
    });

    try {
      const context = await browser.newContext({
        extraHTTPHeaders: options.headers,
        javaScriptEnabled: options.javascript,
        userAgent: options.mobile
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)'
          : undefined,
        viewport: options.mobile ? { width: 375, height: 667 } : undefined,
      });

      if (options.cookies) {
        await context.addCookies(
          options.cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain || new URL(sanitizedUrl).hostname,
            path: '/',
          }))
        );
      }

      const page = await context.newPage();
      const waitUntil =
        options.waitFor === 'networkidle' ? 'networkidle' : options.waitFor || 'load';
      await page.goto(sanitizedUrl, {
        waitUntil,
        timeout: options.timeout || this.config.timeout || 30_000,
      });

      return callback(page, sanitizedUrl, startedAt);
    } finally {
      await browser.close();
    }
  }
  private async loadPlaywright(): Promise<PlaywrightModule> {
    if (!this.playwright) {
      try {
        const moduleName = 'playwright';
        this.playwright = (await import(moduleName)) as PlaywrightModule;
      } catch {
        throw new Error('Playwright is not installed. Install with: npm install playwright');
      }
    }

    return this.playwright;
  }
}
