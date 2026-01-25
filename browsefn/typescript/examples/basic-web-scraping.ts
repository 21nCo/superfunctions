/**
 * Basic web scraping example
 */

import { browseFn } from '../src/index.js';

async function main() {
  // Initialize BrowseFn with Cheerio provider (no external dependencies)
  const browse = browseFn({
    web: {
      defaultProvider: 'cheerio',
      cache: {
        enabled: true,
        defaultTTL: 3600000 // 1 hour
      }
    }
  });

  console.log('Fetching example.com...\n');

  // Get page in HTML format
  const htmlPage = await browse.web.getPage('https://example.com', {
    format: 'html'
  });

  console.log('HTML Title:', htmlPage.metadata.title);
  console.log('Content length:', htmlPage.content.length);
  console.log('Cached:', htmlPage.cached);
  console.log('Provider:', htmlPage.provider);
  console.log('Duration:', htmlPage.duration + 'ms');
  console.log();

  // Get page in Markdown format
  const markdownPage = await browse.web.getPage('https://example.com', {
    format: 'markdown'
  });

  console.log('Markdown content:');
  console.log(markdownPage.content.substring(0, 200) + '...');
  console.log();

  // Get page metadata only
  const urls = [
    'https://example.com',
    'https://github.com',
    'https://npmjs.com'
  ];

  console.log('Fetching metadata for multiple URLs...\n');

  const metadata = await browse.web.getMultipleMetadata(urls, {
    fields: ['title', 'description'],
    concurrency: 2,
    onProgress: (completed, total) => {
      console.log(`Progress: ${completed}/${total}`);
    }
  });

  metadata.forEach((result, index) => {
    if (result.success) {
      console.log(`\n${urls[index]}`);
      console.log('  Title:', result.data?.title);
      console.log('  Description:', result.data?.description);
    } else {
      console.log(`\n${urls[index]}`);
      console.log('  Error:', result.error);
    }
  });

  // Get cache statistics
  if (browse.cache) {
    const stats = await browse.cache.getStats();
    console.log('\nCache Statistics:');
    console.log('  Hits:', stats.hits);
    console.log('  Misses:', stats.misses);
    console.log('  Hit Rate:', stats.hitRate.toFixed(2) + '%');
    console.log('  Size:', stats.size);
  }
}

main().catch(console.error);
