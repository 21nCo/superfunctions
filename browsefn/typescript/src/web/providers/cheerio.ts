/**
 * Cheerio provider for lightweight HTML scraping
 */

import * as cheerio from 'cheerio';
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
    selectors: true
  };

  constructor(private config: { timeout?: number } = {}) {}

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    const startTime = Date.now();
    const sanitizedUrl = sanitizeUrl(url);
    
    // Fetch HTML
    const response = await fetch(sanitizedUrl, {
      headers: options.headers,
      signal: AbortSignal.timeout(options.timeout || this.config.timeout || 10000)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let html = await response.text();
    
    // Apply selectors
    if (options.selectors) {
      html = applySelectors(html, options.selectors);
    }
    
    // Extract metadata
    const metadata = extractMetadata(html, sanitizedUrl);
    
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
        links: extractLinks(html, sanitizedUrl),
        images: extractImages(html, sanitizedUrl)
      };
      content = JSON.stringify(jsonData, null, 2);
    }
    
    // Extract links and images if needed
    const links = options.includeLinks !== false ? extractLinks(html, sanitizedUrl) : undefined;
    const images = options.includeImages !== false ? extractImages(html, sanitizedUrl) : undefined;
    
    return {
      url: sanitizedUrl,
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
