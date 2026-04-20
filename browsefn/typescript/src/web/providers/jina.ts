/**
 * Jina reader provider.
 */

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

export class JinaProvider implements WebProvider {
  name = 'jina';

  capabilities: ProviderCapabilities = {
    formats: ['html', 'markdown', 'text', 'json'],
    javascript: true,
    screenshots: false,
    cookies: false,
    headers: true,
    selectors: false,
    proxy: false,
    scriptExecution: false,
  };

  constructor(private config: ProviderConfig = {}) {}

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    const startedAt = Date.now();
    const sanitizedUrl = sanitizeUrl(url);
    const endpoint = this.config.endpoint || 'https://r.jina.ai/http://';
    const target = endpoint.endsWith('/')
      ? `${endpoint}${sanitizedUrl.replace(/^https?:\/\//, '')}`
      : `${endpoint}/${sanitizedUrl.replace(/^https?:\/\//, '')}`;

    const response = await fetch(target, {
      headers: {
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...(options.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const markdown = await response.text();
    const html = `<article>${markdown}</article>`;
    const metadata = extractMetadata(html, sanitizedUrl);
    const format = options.format || 'markdown';

    return {
      url: sanitizedUrl,
      content: this.resolveContent(format, html, markdown, metadata),
      metadata,
      links: options.includeLinks ? extractLinks(html, sanitizedUrl) : undefined,
      images: options.includeImages ? extractImages(html, sanitizedUrl) : undefined,
      provider: this.name,
      duration: Date.now() - startedAt,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private resolveContent(
    format: NonNullable<GetPageOptions['format']>,
    html: string,
    markdown: string,
    metadata: PageResult['metadata']
  ): string {
    if (format === 'html') {
      return html;
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

    return markdown || htmlToMarkdown(html);
  }
}
