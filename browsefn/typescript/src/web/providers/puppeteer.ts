/**
 * Puppeteer provider for JavaScript-enabled scraping
 */

import type { WebProvider, GetPageOptions, PageResult, ProviderCapabilities } from '../../core/types.js';
import { extractMetadata, applySelectors, htmlToText, htmlToMarkdown } from '../../utils/html-utils.js';
import { sanitizeUrl } from '../../utils/validation.js';

export class PuppeteerProvider implements WebProvider {
  name = 'puppeteer';
  
  capabilities: ProviderCapabilities = {
    formats: ['html', 'markdown', 'text', 'json'],
    javascript: true,
    screenshots: true,
    cookies: true,
    headers: true,
    selectors: true,
    proxy: true
  };

  private puppeteer: any;

  constructor(
    private config: {
      headless?: boolean;
      executablePath?: string;
      args?: string[];
      timeout?: number;
    } = {}
  ) {}

  async getPage(url: string, options: GetPageOptions = {}): Promise<PageResult> {
    // Lazy load puppeteer
    if (!this.puppeteer) {
      try {
        this.puppeteer = await import('puppeteer');
      } catch (error) {
        throw new Error('Puppeteer is not installed. Install with: npm install puppeteer');
      }
    }

    const startTime = Date.now();
    const sanitizedUrl = sanitizeUrl(url);
    
    const browser = await this.puppeteer.launch({
      headless: this.config.headless ?? true,
      executablePath: this.config.executablePath,
      args: this.config.args || ['--no-sandbox', '--disable-setuid-sandbox']
    });

    let screenshot: Buffer | undefined;
    
    try {
      const page = await browser.newPage();
      
      // Set headers
      if (options.headers) {
        await page.setExtraHTTPHeaders(options.headers);
      }
      
      // Set cookies
      if (options.cookies) {
        await page.setCookie(...options.cookies);
      }
      
      // Set viewport for mobile
      if (options.mobile) {
        await page.setViewport({ width: 375, height: 667, isMobile: true });
      }
      
      // Navigate to page
      const waitUntil = options.waitFor === 'networkidle' ? 'networkidle2' : options.waitFor || 'load';
      await page.goto(sanitizedUrl, {
        waitUntil,
        timeout: options.timeout || this.config.timeout || 30000
      });
      
      // Disable JavaScript if requested
      if (options.javascript === false) {
        await page.setJavaScriptEnabled(false);
      }
      
      // Take screenshot
      if (options.screenshot) {
        const screenshotOptions = typeof options.screenshot === 'object' ? options.screenshot : {};
        screenshot = await page.screenshot({
          fullPage: screenshotOptions.fullPage,
          type: screenshotOptions.format || 'png',
          quality: screenshotOptions.quality
        }) as Buffer;
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
        // Use Puppeteer's evaluate to extract structured data
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
      if (!this.puppeteer) {
        this.puppeteer = await import('puppeteer');
      }
      return true;
    } catch {
      return false;
    }
  }
}
