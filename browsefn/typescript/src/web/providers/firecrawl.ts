/** Firecrawl v1 scrape protocol. Browser lifecycle options require a local browser provider. */
import type { GetPageOptions, PageResult, ProviderConfig, ProviderCapabilities, WebProvider } from '../../core/types.js';
import { BrowseFnError } from '../../core/errors.js';
import { sanitizeUrl } from '../../utils/validation.js';
import { remotePage, remoteScreenshot, targetCookies, unsupported } from './remote-utils.js';

export class FirecrawlProvider implements WebProvider {
  name = 'firecrawl';
  capabilities: ProviderCapabilities = { formats: ['html', 'markdown', 'text', 'json'], javascript: true, screenshots: true, cookies: true, headers: true, selectors: true, proxy: true, scriptExecution: false };
  constructor(private config: ProviderConfig) {}

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    const startedAt = Date.now(), target = sanitizeUrl(url);
    if (options.waitFor) unsupported(this.name, 'Firecrawl uses a numeric wait delay, not browser lifecycle events; use Puppeteer or Playwright for waitFor. Configure waitForMs for a Firecrawl delay.');
    if (options.javascript === false) unsupported(this.name, 'Firecrawl does not expose a JavaScript-disable switch; use Cheerio for static HTML.');
    if (options.proxy && !['basic', 'enhanced', 'auto'].includes(options.proxy)) unsupported(this.name, 'Firecrawl proxy accepts basic, enhanced or auto, not a custom proxy URL.');
    const headers = new Headers(options.headers);
    if (this.config.userAgent && !headers.has('user-agent')) headers.set('user-agent', this.config.userAgent);
    const cookies = targetCookies(target, options.cookies ?? []).map(c => `${c.name}=${c.value}`).join('; ');
    if (cookies) headers.set('cookie', [headers.get('cookie'), cookies].filter(Boolean).join('; '));
    const targetHeaders: Record<string, string> = {};
    headers.forEach((value, key) => { targetHeaders[key] = value; });
    const formats = ['html'];
    if (options.format === 'markdown') formats.push('markdown');
    if (options.screenshot) formats.push(typeof options.screenshot === 'object' && options.screenshot.fullPage ? 'screenshot@fullPage' : 'screenshot');
    const timeout = options.timeout ?? this.config.timeout ?? 30000;
    const response = await fetch(this.config.endpoint || 'https://api.firecrawl.dev/v1/scrape', {
      method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify({ url: target, formats, onlyMainContent: false, timeout, mobile: options.mobile, headers: targetHeaders, includeTags: options.selectors?.include, excludeTags: options.selectors?.exclude, proxy: options.proxy, waitFor: this.config.waitForMs }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const payload = await response.json() as { success?: boolean; error?: string; data?: { html?: string; markdown?: string; screenshot?: string; metadata?: Record<string, unknown> } };
    if (payload.success === false || typeof payload.data?.html !== 'string') throw new BrowseFnError({ code: 'PROVIDER_ERROR', provider: this.name, message: payload.error || 'Firecrawl returned no HTML document.' });
    const status = payload.data.metadata?.statusCode;
    if (typeof status === 'number' && status >= 400) throw new Error(`HTTP ${status}: Firecrawl target request failed`);
    const resolved = typeof payload.data.metadata?.sourceURL === 'string' ? sanitizeUrl(payload.data.metadata.sourceURL) : target;
    const page = remotePage(this.name, resolved, payload.data.html, options, startedAt, payload.data.metadata, payload.data.markdown);
    page.screenshot = await remoteScreenshot(payload.data.screenshot, options.screenshot);
    page.duration = Date.now() - startedAt;
    return page;
  }
  async isAvailable(): Promise<boolean> { return Boolean(this.config.apiKey || this.config.endpoint); }
}
