/**
 * Firecrawl provider.
 */

import { Buffer } from 'node:buffer';

import type {
  GetPageOptions,
  PageResult,
  ProviderConfig,
  ProviderCapabilities,
  WebProvider,
} from '../../core/types.js';
import {
  extractImages,
  extractLinks,
  extractMetadata,
  htmlToMarkdown,
  htmlToText,
} from '../../utils/html-utils.js';
import { sanitizeUrl } from '../../utils/validation.js';

export class FirecrawlProvider implements WebProvider {
  name = 'firecrawl';

  capabilities: ProviderCapabilities = {
    formats: ['html', 'markdown', 'text', 'json'],
    javascript: true,
    screenshots: true,
    cookies: true,
    headers: true,
    selectors: true,
    proxy: true,
    scriptExecution: false,
  };

  constructor(private config: ProviderConfig) {}

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    const startedAt = Date.now();
    const sanitizedUrl = sanitizeUrl(url);
    const endpoint = this.config.endpoint || 'https://api.firecrawl.dev/v1/scrape';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        url: sanitizedUrl,
        formats: [options.format || 'html'],
        waitFor: options.waitFor,
        timeout: options.timeout,
        mobile: options.mobile,
        headers: options.headers,
        includeLinks: options.includeLinks,
        includeImages: options.includeImages,
        screenshot: options.screenshot,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      success?: boolean;
      data?: {
        html?: string;
        markdown?: string;
        content?: string;
        screenshot?: string;
        links?: string[];
        images?: string[];
        metadata?: Record<string, unknown>;
      };
    };

    const html = payload.data?.html || payload.data?.content || '';
    const markdown = payload.data?.markdown;
    const metadata = this.normalizeMetadata(payload.data?.metadata, sanitizedUrl, html);
    const content = this.resolveContent(options.format || 'html', html, markdown, metadata);

    return {
      url: sanitizedUrl,
      content,
      metadata,
      links:
        options.includeLinks
          ? payload.data?.links || extractLinks(html, sanitizedUrl)
          : undefined,
      images:
        options.includeImages
          ? payload.data?.images || extractImages(html, sanitizedUrl)
          : undefined,
      screenshot: payload.data?.screenshot
        ? Uint8Array.from(Buffer.from(payload.data.screenshot, 'base64'))
        : undefined,
      provider: this.name,
      duration: Date.now() - startedAt,
    };
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.config.apiKey || this.config.endpoint);
  }

  private normalizeMetadata(
    rawMetadata: Record<string, unknown> | undefined,
    url: string,
    html: string
  ): PageResult['metadata'] {
    const extracted = extractMetadata(html, url);
    if (!rawMetadata) {
      return extracted;
    }

    return {
      ...extracted,
      ...rawMetadata,
      url,
    };
  }

  private resolveContent(
    format: NonNullable<GetPageOptions['format']>,
    html: string,
    markdown: string | undefined,
    metadata: PageResult['metadata']
  ): string {
    if (format === 'markdown') {
      return markdown || htmlToMarkdown(html);
    }
    if (format === 'text') {
      return htmlToText(html);
    }
    if (format === 'json') {
      return JSON.stringify(
        {
          title: metadata.title,
          description: metadata.description,
          links: extractLinks(html, metadata.url),
          images: extractImages(html, metadata.url),
        },
        null,
        2
      );
    }
    return html;
  }
}
