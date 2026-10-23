import { BrowseFnError } from '../../core/errors.js';
/**
 * Shared helpers for browser-backed web providers.
 */

import type {
  GetPageOptions,
  PageResult,
  ProviderCapabilities,
} from '../../core/types.js';
import {
  applySelectors,
  extractImages,
  extractLinks,
  extractMetadata,
  htmlToMarkdown,
  htmlToText,
} from '../../utils/html-utils.js';

type JsonPagePayload = {
  title: string;
  body: string;
  links: string[];
  images: string[];
};

type BrowserPageLike = {
  content(): Promise<string>;
  screenshot(options: {
    fullPage?: boolean;
    type?: 'png' | 'jpeg';
    quality?: number;
  }): Promise<Uint8Array>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
};

export const BROWSER_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  formats: ['html', 'markdown', 'text', 'json'],
  javascript: true,
  screenshots: true,
  cookies: true,
  headers: true,
  selectors: true,
  proxy: true,
  scriptExecution: true,
};

export async function buildBrowserPageResult({
  page,
  options,
  sanitizedUrl,
  provider,
  startedAt,
}: {
  page: BrowserPageLike;
  options: GetPageOptions;
  sanitizedUrl: string;
  provider: string;
  startedAt: number;
}): Promise<PageResult> {
  const checkContentSize = (value: string) => {
    if (Buffer.byteLength(value, 'utf8') > 10 * 1024 * 1024) throw new BrowseFnError({ code: 'DOWNLOAD_TOO_LARGE', message: 'Page payload exceeds the 10 MiB limit.' });
  };
  // Reject before parsing, formatting, screenshot capture or cache publication.
  // page.content() itself has already materialized the browser protocol response.
  let html = await page.content();
  checkContentSize(html);
  let screenshot: Uint8Array | undefined;

  if (options.screenshot) {
    const screenshotOptions =
      typeof options.screenshot === 'object' ? options.screenshot : {};
    screenshot = await page.screenshot({
      fullPage: screenshotOptions.fullPage,
      type: screenshotOptions.format || 'png',
      quality: screenshotOptions.quality,
    });
  }

  if (options.selectors) {
    html = applySelectors(html, options.selectors);
  }

  const metadata = extractMetadata(html, sanitizedUrl);
  const content = await formatBrowserContent(page, html, options.format || 'html');
  checkContentSize(content);

  return {
    url: sanitizedUrl,
    content,
    metadata,
    links: options.includeLinks ? extractLinks(html, sanitizedUrl) : undefined,
    images: options.includeImages ? extractImages(html, sanitizedUrl) : undefined,
    screenshot,
    provider,
    duration: Date.now() - startedAt,
  };
}

export async function formatBrowserContent(
  page: BrowserPageLike,
  html: string,
  format: NonNullable<GetPageOptions['format']>
): Promise<string> {
  if (format === 'markdown') {
    return htmlToMarkdown(html);
  }
  if (format === 'text') {
    return htmlToText(html);
  }
  if (format === 'json') {
    const jsonData = await page.evaluate<JsonPagePayload>(() => ({
      title: document.title,
      body: document.body.innerText,
      links: Array.from(document.querySelectorAll('a')).map((a) => a.href),
      images: Array.from(document.querySelectorAll('img')).map((img) => img.src),
    }));
    return JSON.stringify(jsonData, null, 2);
  }

  return html;
}

export async function isProviderModuleAvailable(
  loadModule: () => Promise<unknown>
): Promise<boolean> {
  try {
    await loadModule();
    return true;
  } catch {
    return false;
  }
}

/** Keep the browser alive through extraction and preserve the primary failure. */
export async function useBrowser<T>(browser: { close(): Promise<void> }, operation: () => Promise<T>): Promise<T> {
  let failed = false;
  try {
    return await operation();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await browser.close(); } catch (error) { if (!failed) throw error; }
  }
}

export function parseBrowserProxy(value?: string): { server: string; username?: string; password?: string } | undefined {
  if (!value) return undefined;
  const url = new URL(value.includes('://') ? value : `http://${value}`);
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Unsupported browser proxy URL');
  }
  return {
    server: `${url.protocol}//${url.host}`,
    ...(url.username || url.password ? {
      username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    } : {}),
  };
}

/** Common public extraction operations for browser runtimes. */
export abstract class BrowserProviderBase<Page extends BrowserPageLike> {
  abstract name: string;
  capabilities: ProviderCapabilities = BROWSER_PROVIDER_CAPABILITIES;

  protected abstract withPage<T>(
    url: string, options: GetPageOptions,
    callback: (page: Page, resolvedUrl: string, startedAt: number) => Promise<T>
  ): Promise<T>;

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    return this.withPage(url, options, (page, sanitizedUrl, startedAt) =>
      buildBrowserPageResult({ page, options, sanitizedUrl, provider: this.name, startedAt })
    );
  }

  async scrape<T>(url: string, options: GetPageOptions & { script: (page: unknown) => Promise<T> | T }): Promise<T> {
    return this.withPage(url, options, async page => options.script(page));
  }
}
