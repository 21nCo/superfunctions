/**
 * Puppeteer provider for JavaScript-enabled scraping.
 */

import type {
  GetPageOptions,
  WebProvider,
} from '../../core/types.js';
import { sanitizeUrl } from '../../utils/validation.js';
import {
  BrowserProviderBase,
  isProviderModuleAvailable,
  useBrowser,
  parseBrowserProxy,
} from './browser-provider-utils.js';

type PuppeteerPage = {
  authenticate(credentials: { username: string; password: string }): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  setCookie(...cookies: NonNullable<GetPageOptions['cookies']>): Promise<void>;
  setViewport(viewport: { width: number; height: number; isMobile?: boolean }): Promise<void>;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  content(): Promise<string>;
  url(): string;
  screenshot(options: {
    fullPage?: boolean;
    type?: 'png' | 'jpeg';
    quality?: number;
  }): Promise<Uint8Array>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
};

type PuppeteerBrowser = {
  newPage(): Promise<PuppeteerPage>;
  close(): Promise<void>;
};

type PuppeteerModule = {
  launch(options: {
    headless: boolean;
    executablePath?: string;
    args: string[];
  }): Promise<PuppeteerBrowser>;
};

export class PuppeteerProvider extends BrowserProviderBase<PuppeteerPage> implements WebProvider {
  name = 'puppeteer';

  private puppeteer?: PuppeteerModule;

  constructor(
    private config: {
      headless?: boolean;
      executablePath?: string;
      args?: string[];
      timeout?: number;
    } = {}
  ) { super(); }

  async isAvailable(): Promise<boolean> {
    return isProviderModuleAvailable(() => this.loadPuppeteer());
  }

  protected async withPage<T>(
    url: string,
    options: GetPageOptions,
    callback: (page: PuppeteerPage, sanitizedUrl: string, startedAt: number) => Promise<T>
  ): Promise<T> {
    const puppeteer = await this.loadPuppeteer();
    const startedAt = Date.now();
    const sanitizedUrl = sanitizeUrl(url);

    const proxy = parseBrowserProxy(options.proxy);
    const browser = await puppeteer.launch({
      headless: this.config.headless ?? true,
      executablePath: this.config.executablePath,
      args: [...(this.config.args || []), ...(proxy ? [`--proxy-server=${proxy.server}`] : [])],
    });

    return useBrowser(browser, async () => {
      const page = await browser.newPage();

      if (proxy?.username !== undefined) {
        await page.authenticate({ username: proxy.username, password: proxy.password ?? '' });
      }

      if (options.headers) {
        await page.setExtraHTTPHeaders(options.headers);
      }

      if (options.cookies) {
        await page.setCookie(...options.cookies);
      }

      if (options.mobile) {
        await page.setViewport({ width: 375, height: 667, isMobile: true });
      }

      if (options.javascript === false) {
        await page.setJavaScriptEnabled(false);
      }

      const waitUntil =
        options.waitFor === 'networkidle' ? 'networkidle2' : options.waitFor || 'load';
      await page.goto(sanitizedUrl, {
        waitUntil,
        timeout: options.timeout || this.config.timeout || 30_000,
      });

      return await callback(page, page.url(), startedAt);
    });
  }
  private async loadPuppeteer(): Promise<PuppeteerModule> {
    if (!this.puppeteer) {
      try {
        const moduleName = 'puppeteer';
        this.puppeteer = (await import(moduleName)) as PuppeteerModule;
      } catch {
        throw new Error('Puppeteer is not installed. Install with: npm install puppeteer');
      }
    }

    return this.puppeteer;
  }
}
