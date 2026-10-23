import { browserDeadline } from '../isolation/lifecycle.js';
import { assertBrowserDestination } from '../isolation/egress-proxy.js';
import { launchIsolatedBrowser, type BrowserIsolation } from '../isolation/docker-browser.js';
import { denied } from '../../utils/destination-policy.js';
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
  connect(options: { browserWSEndpoint: string }): Promise<PuppeteerBrowser>;
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
      isolation?: BrowserIsolation;
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
    const protectedRequest = !!options.security && !options.security.allowPrivateHosts;
    if (protectedRequest && (!this.config.isolation || proxy || this.config.headless === false)) throw denied();
    const deadline = browserDeadline(options.timeout ?? this.config.timeout ?? 30_000, startedAt);
    if (protectedRequest) await deadline.wait(assertBrowserDestination(sanitizedUrl));
    const isolation = protectedRequest
      ? await launchIsolatedBrowser(this.config.isolation!, 'puppeteer', 'chromium', deadline.remaining())
      : undefined;
    try {
      const browser = isolation
        ? await puppeteer.connect({ browserWSEndpoint: isolation.endpoint })
        : await puppeteer.launch({
          headless: this.config.headless ?? true, executablePath: this.config.executablePath,
          args: [...(this.config.args || []), ...(proxy ? [`--proxy-server=${proxy.server}`] : [])],
        });

      return await useBrowser(browser, async () => {
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
          timeout: protectedRequest ? deadline.remaining() : options.timeout || this.config.timeout || 30_000,
        });

        const operation = callback(page, page.url(), startedAt);
        const result = protectedRequest ? await deadline.wait(operation) : await operation;
        isolation?.assertAllowed();
        return result;
      });
    } catch (error) { isolation?.assertAllowed(); throw error; }
    finally { await isolation?.close(); }
  }

  supportsProtectedDestinations(): boolean { return !!this.config.isolation; }
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
