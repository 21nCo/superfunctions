import type { GetPageOptions, PageResult } from '../../core/types.js';
import { BrowseFnError } from '../../core/errors.js';
import { applySelectors, extractImages, extractLinks, extractMetadata, htmlToMarkdown, htmlToText } from '../../utils/html-utils.js';
import { fetchImageBytes } from '../../images/download.js';
import { transformImage } from '../../images/transform.js';

export function unsupported(provider: string, message: string): never {
  throw new BrowseFnError({ code: 'UNSUPPORTED_PROVIDER_CAPABILITY', provider, message });
}

export function remotePage(provider: string, url: string, source: string, options: GetPageOptions, startedAt: number, rawMetadata?: Record<string, unknown>, markdown?: string): PageResult {
  const metadata = { ...extractMetadata(source, url), ...rawMetadata, url };
  const html = applySelectors(source, options.selectors);
  const links = extractLinks(html, url), images = extractImages(html, url);
  const format = options.format ?? 'html';
  const content = format === 'text' ? htmlToText(html) : format === 'markdown' ? (options.selectors ? htmlToMarkdown(html) : markdown ?? htmlToMarkdown(html)) : format === 'json' ? JSON.stringify({ title: metadata.title, description: metadata.description, links, images }) : html;
  return { url, content, metadata, links: options.includeLinks ? links : undefined, images: options.includeImages ? images : undefined, provider, duration: Date.now() - startedAt };
}

export async function remoteScreenshot(url: unknown, option: GetPageOptions['screenshot']): Promise<Uint8Array | undefined> {
  if (!option) return undefined;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new BrowseFnError({ code: 'PROVIDER_ERROR', message: 'Provider did not return a screenshot URL.' });
  const settings = typeof option === 'object' ? option : {};
  return (await transformImage(await fetchImageBytes(url, {}), { format: settings.format ?? 'png', quality: settings.quality })).bytes;
}

export function targetCookies(url: string, cookies: NonNullable<GetPageOptions['cookies']>): typeof cookies {
  const hostname = new URL(url).hostname;
  return cookies.filter(cookie => {
    const domain = cookie.domain?.replace(/^\./, '');
    if (!domain) return true;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}
