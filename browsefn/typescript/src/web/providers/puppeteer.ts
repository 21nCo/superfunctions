/**
 * Puppeteer provider for JavaScript-enabled scraping.
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

type PuppeteerModule = typeof import('puppeteer');

export class PuppeteerProvider implements WebProvider {
  name = 'puppeteer';

  capabilities: ProviderCapabilities = BROWSER_PROVIDER_CAPABILITIES;

  private puppeteer?: PuppeteerModule;

  constructor(
    private config: {
      headless?: boolean;
      executablePath?: string;
      args?: string[];
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
    return isProviderModuleAvailable(() => this.loadPuppeteer());
  }

  private async withPage<T>(
    url: string,
    options: GetPageOptions,
    callback: (page: Awaited<ReturnType<Awaited<ReturnType<PuppeteerModule['launch']>>['newPage']>>, sanitizedUrl: string, startedAt: number) => Promise<T>
  ): Promise<T> {
    const puppeteer = await this.loadPuppeteer();
    const startedAt = Date.now();
    const sanitizedUrl = sanitizeUrl(url);

    const browser = await puppeteer.launch({
      headless: this.config.headless ?? true,
      executablePath: this.config.executablePath,
      args: this.config.args || ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();

      if (options.headers) {
        await page.setExtraHTTPHeaders(options.headers);
      }

      if (options.cookies) {
        await page.setCookie(...options.cookies);
      }

      if (options.mobile) {
        await page.setViewport({ width: 375, height: 667, isMobile: true });
      }

      const waitUntil =
        options.waitFor === 'networkidle' ? 'networkidle2' : options.waitFor || 'load';
      await page.goto(sanitizedUrl, {
        waitUntil,
        timeout: options.timeout || this.config.timeout || 30_000,
      });

      if (options.javascript === false) {
        await page.setJavaScriptEnabled(false);
      }

      return callback(page, sanitizedUrl, startedAt);
    } finally {
      await browser.close();
    }
  }
  private async loadPuppeteer(): Promise<PuppeteerModule> {
    if (!this.puppeteer) {
      try {
        this.puppeteer = await import('puppeteer');
      } catch {
        throw new Error('Puppeteer is not installed. Install with: npm install puppeteer');
      }
    }

    return this.puppeteer;
  }
}
