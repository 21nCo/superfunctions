/**
 * Image search example using Unsplash
 */

import { browseFn } from '../src/index.js';

async function main() {
  const apiKey = process.env.UNSPLASH_ACCESS_KEY;

  if (!apiKey) {
    console.error('Please set UNSPLASH_ACCESS_KEY environment variable');
    process.exit(1);
  }

  const browse = browseFn({
    images: {
      defaultProvider: 'unsplash',
      providers: {
        unsplash: {
          apiKey,
          rateLimit: { requests: 50, window: 3600000 } // 50 requests per hour
        }
      },
      cache: {
        enabled: true,
        defaultTTL: 3600000
      }
    }
  });

  console.log('Searching for mountain landscape images...\n');

  // Search for images
  const results = await browse.images.search('mountain landscape', {
    page: 1,
    perPage: 10,
    orientation: 'landscape',
    orderBy: 'relevant',
    filters: {
      minWidth: 1920,
      minHeight: 1080
    }
  });

  console.log(`Found ${results.total} images`);
  console.log(`Showing page ${results.page} (${results.results.length} results)\n`);

  results.results.forEach((image, index) => {
    console.log(`${index + 1}. ${image.description || 'No description'}`);
    console.log(`   By: ${image.author?.name}`);
    console.log(`   Size: ${image.width}x${image.height}`);
    console.log(`   URL: ${image.url}`);
    console.log(`   Downloads: ${Object.keys(image.downloads || {}).join(', ')}`);
    console.log();
  });

  // Check rate limit status
  const rateLimitStatus = browse.getRateLimitStatus('unsplash');
  console.log('Rate Limit Status:');
  console.log('  Remaining:', rateLimitStatus.remaining);
  console.log('  Limit:', rateLimitStatus.limit);
  console.log('  Resets at:', new Date(rateLimitStatus.resetAt).toISOString());
}

main().catch(console.error);
