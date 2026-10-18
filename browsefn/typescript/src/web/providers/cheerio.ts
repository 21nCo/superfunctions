/**
 * Cheerio provider for lightweight HTML scraping
 */

import * as cheerio from 'cheerio';
import { ProxyAgent, fetch as proxyFetch } from 'undici';
import type { WebProvider, GetPageOptions, PageResult, ProviderCapabilities } from '../../core/types.js';
import { extractMetadata, extractLinks, extractImages, applySelectors, htmlToText, htmlToMarkdown } from '../../utils/html-utils.js';
import { sanitizeUrl } from '../../utils/validation.js';

export class CheerioProvider implements WebProvider {
  name = 'cheerio';

  capabilities: ProviderCapabilities = {
    formats: ['html', 'markdown', 'text', 'json'],
    javascript: false,
    screenshots: false,
    cookies: false,
    headers: true,
    selectors: true,
    proxy: true,
    scriptExecution: false
  };

  constructor(private config: { timeout?: number } = {}) {}

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    const startTime = Date.now();
    const sanitizedUrl = sanitizeUrl(url);

    const agent = options.proxy ? new ProxyAgent(options.proxy) : undefined;
    let html: string, resolvedUrl: string;
    try {
      const requestOptions = { headers: options.headers, signal: AbortSignal.timeout(options.timeout || this.config.timeout || 10000) };
      const response = agent
        ? await proxyFetch(sanitizedUrl, { ...requestOptions, dispatcher: agent })
        : await fetch(sanitizedUrl, requestOptions);
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}: ${response.statusText}`); }
      resolvedUrl = response.url || sanitizedUrl;
      html = await response.text();
    } finally { await agent?.close(); }

    // Apply selectors
    if (options.selectors) {
      html = applySelectors(html, options.selectors);
    }

    // Extract metadata
    const metadata = extractMetadata(html, resolvedUrl);

    // Convert to requested format
    let content = html;
    const format = options.format || 'html';

    if (format === 'markdown') {
      content = htmlToMarkdown(html);
    } else if (format === 'text') {
      content = htmlToText(html);
    } else if (format === 'json') {
      const $ = cheerio.load(html);
      const jsonData = {
        title: metadata.title,
        body: $('body').text().trim(),
        links: extractLinks(html, resolvedUrl),
        images: extractImages(html, resolvedUrl)
      };
      content = JSON.stringify(jsonData, null, 2);
    }

    // Extract links and images if needed
    const links = options.includeLinks ? extractLinks(html, resolvedUrl) : undefined;
    const images = options.includeImages ? extractImages(html, resolvedUrl) : undefined;

    return {
      url: resolvedUrl,
      content,
      metadata,
      links,
      images,
      provider: this.name,
      duration: Date.now() - startTime
    };
  }

  async isAvailable(): Promise<boolean> {
    return true; // Cheerio is always available
  }
}
