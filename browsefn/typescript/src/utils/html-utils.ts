/**
 * HTML utilities for parsing and extracting data
 */

import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import type { PageMetadata } from '../core/types.js';

/**
 * Convert HTML to plain text
 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  
  // Remove script and style tags
  $('script, style, noscript').remove();
  
  // Get text content
  return $('body').text().trim().replace(/\s+/g, ' ');
}

/** Preserve document order, nested lists, links, emphasis and fenced code. */
export function htmlToMarkdown(html: string): string {
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  converter.remove(['script', 'style', 'noscript']);
  // Preserve tables as HTML rather than silently discarding their structure.
  converter.keep(['table']);
  return converter.turndown(html);
}

/**
 * Extract metadata from HTML
 */
export function extractMetadata(html: string, url: string): PageMetadata {
  const $ = cheerio.load(html);
  
  const metadata: PageMetadata = { url };
  
  // Basic metadata
  metadata.title = $('title').text().trim() || $('meta[property="og:title"]').attr('content');
  metadata.description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content');
  metadata.image = $('meta[property="og:image"]').attr('content');
  metadata.author = $('meta[name="author"]').attr('content');
  metadata.keywords = $('meta[name="keywords"]').attr('content')?.split(',').map(k => k.trim());
  metadata.favicon = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href');
  metadata.siteName = $('meta[property="og:site_name"]').attr('content');
  metadata.locale = $('meta[property="og:locale"]').attr('content') || $('html').attr('lang');
  metadata.type = $('meta[property="og:type"]').attr('content');
  
  // Published date
  const publishedStr = $('meta[property="article:published_time"]').attr('content');
  if (publishedStr) {
    metadata.published = new Date(publishedStr);
  }
  
  // Open Graph
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const ogDescription = $('meta[property="og:description"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');
  const ogType = $('meta[property="og:type"]').attr('content');
  const ogUrl = $('meta[property="og:url"]').attr('content');
  
  if (ogTitle || ogDescription || ogImage || ogType || ogUrl) {
    metadata.openGraph = {
      title: ogTitle,
      description: ogDescription,
      image: ogImage,
      type: ogType,
      url: ogUrl
    };
  }
  
  // Twitter Card
  const twitterCard = $('meta[name="twitter:card"]').attr('content');
  const twitterSite = $('meta[name="twitter:site"]').attr('content');
  const twitterTitle = $('meta[name="twitter:title"]').attr('content');
  const twitterDescription = $('meta[name="twitter:description"]').attr('content');
  const twitterImage = $('meta[name="twitter:image"]').attr('content');
  
  if (twitterCard || twitterSite || twitterTitle || twitterDescription || twitterImage) {
    metadata.twitter = {
      card: twitterCard,
      site: twitterSite,
      title: twitterTitle,
      description: twitterDescription,
      image: twitterImage
    };
  }
  
  // JSON-LD
  const jsonLdScripts = $('script[type="application/ld+json"]');
  const jsonLd: any[] = [];
  jsonLdScripts.each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || '');
      jsonLd.push(data);
    } catch {
      // Ignore invalid JSON-LD
    }
  });
  if (jsonLd.length > 0) {
    metadata.jsonLd = jsonLd;
  }
  
  return metadata;
}

/**
 * Extract links from HTML
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];
  
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      try {
        const absolute = new URL(href, baseUrl).toString();
        links.push(absolute);
      } catch {
        // Ignore invalid URLs
      }
    }
  });
  
  return Array.from(new Set(links));
}

/**
 * Extract images from HTML
 */
export function extractImages(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const images: string[] = [];
  
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      try {
        const absolute = new URL(src, baseUrl).toString();
        images.push(absolute);
      } catch {
        // Ignore invalid URLs
      }
    }
  });
  
  return Array.from(new Set(images));
}

/**
 * Apply selectors to HTML
 */
export function applySelectors(
  html: string,
  selectors?: { include?: string[]; exclude?: string[] }
): string {
  if (!selectors) return html;
  
  const $ = cheerio.load(html);
  
  // Apply exclude selectors
  if (selectors.exclude) {
    selectors.exclude.forEach(selector => {
      $(selector).remove();
    });
  }
  
  // Apply include selectors
  if (selectors.include && selectors.include.length > 0) {
    const includedHtml = selectors.include
      .flatMap(selector => $(selector).toArray().map(element => $.html(element)))
      .filter(Boolean)
      .join('\n');
    return includedHtml;
  }
  
  return $.html();
}
