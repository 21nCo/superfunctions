/**
 * Web scraping with Puppeteer for JavaScript-rendered pages
 * 
 * Note: Requires puppeteer to be installed:
 * npm install puppeteer
 */

import { browseFn } from '../src/index.js';

async function main() {
  const browse = browseFn({
    web: {
      defaultProvider: 'puppeteer',
      providers: {
        puppeteer: {
          headless: true,
          timeout: 30000
        }
      },
      fallbackChain: ['puppeteer', 'cheerio']
    }
  });

  console.log('Fetching JavaScript-rendered page with Puppeteer...\n');

  // Get page with screenshot
  const page = await browse.web.getPage('https://example.com', {
    format: 'markdown',
    javascript: true,
    waitFor: 'networkidle',
    screenshot: {
      fullPage: true,
      format: 'png'
    }
  });

  console.log('Title:', page.metadata.title);
  console.log('Content length:', page.content.length);
  console.log('Screenshot captured:', !!page.screenshot);
  console.log('Links found:', page.links?.length || 0);
  console.log('Images found:', page.images?.length || 0);
  console.log('Provider:', page.provider);
  console.log('Duration:', page.duration + 'ms');
  console.log();

  // Get page with custom selectors
  const filteredPage = await browse.web.getPage('https://example.com', {
    format: 'html',
    selectors: {
      include: ['main', 'article'],
      exclude: ['.ads', '.footer', 'script']
    }
  });

  console.log('Filtered content length:', filteredPage.content.length);
  console.log();

  // List available providers
  const providers = await browse.web.listProviders();
  console.log('Available providers:', providers.join(', '));
}

main().catch(console.error);
