/**
 * Playwright provider for cross-browser scraping
 */

import type { WebProvider, GetPageOptions, PageResult, ProviderCapabilities } from '../../core/types.js';
import { extractMetadata, applySelectors, htmlToText, htmlToMarkdown } from '../../utils/html-utils.js';
import { sanitizeUrl } from '../../utils/validation.js';

export class PlaywrightProvider implements WebProvider {
  name = 'playwright';
  
  capabilities: ProviderCapabilities = {
    formats: ['html', 'markdown', 'text', 'json'],
    javascript: true,
    screenshots: true,
    cookies: true,
    headers: true,
    selectors: true,
    proxy: true
  };

  private playwright: any;

  constructor(
    private config: {
      browser?: 'chromium' | 'firefox' | 'webkit';
      headless?: boolean;
      timeout?: number;
    } = {}
  ) {}

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    // Lazy load playwright
    if (!this.playwright) {
      try {
        this.playwright = await import('playwright');
      } catch (error) {
        throw new Error('Playwright is not installed. Install with: npm install playwright');
      }
    }

    const startTime = Date.now();
    const sanitizedUrl = sanitizeUrl(url);
    
    const browserType = this.config.browser || 'chromium';
    const browser = await this.playwright[browserType].launch({
      headless: this.config.headless ?? true
    });

    let screenshot: Buffer | undefined;
    
    try {
      const context = await browser.newContext({
        extraHTTPHeaders: options.headers,
        userAgent: options.mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)' : undefined,
        viewport: options.mobile ? { width: 375, height: 667 } : undefined
      });
      
      // Set cookies
      if (options.cookies) {
        await context.addCookies(options.cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || new URL(sanitizedUrl).hostname,
          path: '/'
        })));
      }
      
      const page = await context.newPage();
      
      // Navigate to page
      const waitUntil = options.waitFor === 'networkidle' ? 'networkidle' : options.waitFor || 'load';
      await page.goto(sanitizedUrl, {
        waitUntil,
        timeout: options.timeout || this.config.timeout || 30000
      });
      
      // Take screenshot
      if (options.screenshot) {
        const screenshotOptions = typeof options.screenshot === 'object' ? options.screenshot : {};
        screenshot = await page.screenshot({
          fullPage: screenshotOptions.fullPage,
          type: screenshotOptions.format || 'png',
          quality: screenshotOptions.quality
        });
      }
      
      // Get HTML
      let html = await page.content();
      
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
        // Use Playwright's evaluate to extract structured data
        const jsonData = await page.evaluate(() => {
          return {
            title: document.title,
            body: document.body.innerText,
            links: Array.from(document.querySelectorAll('a')).map(a => a.href),
            images: Array.from(document.querySelectorAll('img')).map(img => img.src)
          };
        });
        content = JSON.stringify(jsonData, null, 2);
      }
      
      // Extract links and images
      const links = await page.evaluate(() => 
        Array.from(document.querySelectorAll('a')).map(a => a.href)
      );
      const images = await page.evaluate(() => 
        Array.from(document.querySelectorAll('img')).map(img => img.src)
      );
      
      return {
        url: sanitizedUrl,
        content,
        metadata,
        links,
        images,
        screenshot,
        provider: this.name,
        duration: Date.now() - startTime
      };
    } finally {
      await browser.close();
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!this.playwright) {
        this.playwright = await import('playwright');
      }
      return true;
    } catch {
      return false;
    }
  }
}
