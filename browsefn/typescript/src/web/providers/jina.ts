/** Jina Reader POST JSON protocol; target credentials stay separate from API credentials. */
import type { GetPageOptions, PageResult, ProviderConfig, ProviderCapabilities, WebProvider } from '../../core/types.js';
import { BrowseFnError } from '../../core/errors.js';
import { sanitizeUrl } from '../../utils/validation.js';
import { remotePage, remoteScreenshot, targetCookies, unsupported } from './remote-utils.js';

export class JinaProvider implements WebProvider {
  name = 'jina';
  capabilities: ProviderCapabilities = { formats: ['html', 'markdown', 'text', 'json'], javascript: true, screenshots: true, cookies: true, headers: true, selectors: true, proxy: true, scriptExecution: false };
  constructor(private config: ProviderConfig = {}) {}

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    const startedAt = Date.now(), target = sanitizeUrl(url);
    if (options.waitFor && options.waitFor !== 'networkidle') unsupported(this.name, 'Jina exposes network-idle timing, not load or domcontentloaded; use Puppeteer or Playwright for those events.');
    const timeout = options.timeout ?? this.config.timeout ?? 30000;
    const body = { url: target, customHeader: options.headers, userAgent: this.config.userAgent, proxyUrl: options.proxy, timeout: Math.min(timeout / 1000, 180), engine: options.javascript === false ? 'curl' : 'browser', respondTiming: options.waitFor === 'networkidle' ? 'network-idle' : undefined, viewport: options.mobile === undefined ? undefined : { width: options.mobile ? 390 : 1280, height: options.mobile ? 844 : 720, isMobile: options.mobile, hasTouch: options.mobile }, setCookies: targetCookies(target, options.cookies ?? []).map(c => `${c.name}=${c.value}; Domain=${c.domain || new URL(target).hostname}; Path=/`) };
    const signal = AbortSignal.timeout(timeout);
    const request = async (respondWith: string) => {
      const response = await fetch(this.config.endpoint || 'https://r.jina.ai/', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) }, body: JSON.stringify({ ...body, respondWith }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const payload = await response.json() as { code?: number; message?: string; data?: Record<string, unknown> };
      if ((payload.code !== undefined && payload.code !== 200) || !payload.data) throw new BrowseFnError({ code: 'PROVIDER_ERROR', provider: this.name, message: payload.message || 'Jina returned no document.', details: typeof payload.code === 'number' ? { statusCode: payload.code } : undefined });
      return payload.data;
    };
    const data = await request('html');
    if (typeof data.html !== 'string') throw new BrowseFnError({ code: 'PROVIDER_ERROR', provider: this.name, message: 'Jina returned no HTML document.' });
    const resolved = typeof data.url === 'string' ? sanitizeUrl(data.url) : target;
    const page = remotePage(this.name, resolved, data.html, { ...options, format: options.format ?? 'markdown' }, startedAt);
    if (typeof data.title === 'string') page.metadata.title = data.title;
    if (typeof data.description === 'string') page.metadata.description = data.description;
    if (options.screenshot) {
      const full = typeof options.screenshot === 'object' && options.screenshot.fullPage;
      const screenshot = await request(full ? 'pageshot' : 'screenshot');
      page.screenshot = await remoteScreenshot(screenshot[full ? 'pageshotUrl' : 'screenshotUrl'], options.screenshot);
    }
    page.duration = Date.now() - startedAt;
    return page;
  }
  async isAvailable(): Promise<boolean> { return true; }
}
