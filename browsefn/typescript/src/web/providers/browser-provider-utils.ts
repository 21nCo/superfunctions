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

  let html = await page.content();
  if (options.selectors) {
    html = applySelectors(html, options.selectors);
  }

  const metadata = extractMetadata(html, sanitizedUrl);
  const content = await formatBrowserContent(page, html, options.format || 'html');

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
