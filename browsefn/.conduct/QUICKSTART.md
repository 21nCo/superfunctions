# BrowseFn Quick Start Guide

> Get started with BrowseFn in 5 minutes

## Installation

```bash
cd browsefn/ts-sdk
npm install
```

## Build

```bash
npm run build
```

## Run Examples

### 1. Basic Web Scraping (No Dependencies)

The Cheerio provider works out of the box:

```bash
node examples/basic-web-scraping.js
```

This will:
- Scrape example.com
- Convert to HTML and Markdown
- Extract metadata from multiple URLs
- Show cache statistics

### 2. Geocoding (No API Key Required)

Nominatim/OpenStreetMap is free:

```bash
node examples/geocoding.js
```

This will:
- Reverse geocode coordinates to address
- Forward geocode address to coordinates
- Show cached results

### 3. Image Search (Requires API Key)

Sign up for a free Unsplash account and get an API key:

```bash
UNSPLASH_ACCESS_KEY=your_key_here node examples/image-search.js
```

This will:
- Search for images
- Display results with metadata
- Show rate limit status

### 4. Advanced Web Scraping (Requires Puppeteer)

Install Puppeteer:

```bash
npm install puppeteer
```

Then run:

```bash
node examples/with-puppeteer.js
```

This will:
- Scrape with JavaScript rendering
- Capture screenshots
- Apply CSS selectors
- Show provider fallback

## Integration in Your Project

### Add to Package

```bash
npm install browsefn
```

### Basic Usage

```typescript
import { browseFn } from 'browsefn';

const browse = browseFn({
  web: {
    defaultProvider: 'cheerio',
    cache: { enabled: true }
  }
});

const page = await browse.web.getPage('https://example.com');
console.log(page.metadata.title);
```

## Common Use Cases

### 1. Web Scraping for SEO

```typescript
const urls = [
  'https://example.com/page1',
  'https://example.com/page2',
  'https://example.com/page3'
];

const metadata = await browse.web.getMultipleMetadata(urls, {
  fields: ['title', 'description', 'keywords'],
  concurrency: 5
});

metadata.forEach(result => {
  if (result.success) {
    console.log(result.data.title);
  }
});
```

### 2. Content Monitoring

```typescript
const browse = browseFn({
  web: {
    cache: { enabled: true, defaultTTL: 3600000 }
  }
});

setInterval(async () => {
  const page = await browse.web.getPage('https://example.com/news', {
    format: 'text'
  });
  
  if (!page.cached && hasNewContent(page.content)) {
    notifyUser('New content available!');
  }
}, 60000);
```

### 3. Image Collection

```typescript
const results = await browse.images.search('landscape', {
  perPage: 50,
  filters: { minWidth: 1920, safeSearch: true }
});

await browse.images.downloadBatch(
  results.results.map(img => img.downloads?.large || img.url),
  {
    destination: './images',
    concurrency: 5,
    onProgress: (completed, total) => {
      console.log(`Downloaded ${completed}/${total}`);
    }
  }
);
```

### 4. Address Validation

```typescript
async function validateAddress(address: string) {
  const locations = await browse.geo.geocode(address, {
    limit: 1,
    cache: true
  });
  
  if (locations.length > 0) {
    return {
      valid: true,
      normalized: locations[0].address.formatted,
      coordinates: locations[0].location
    };
  }
  
  return { valid: false };
}
```

## Testing Your Setup

Create a test file `test.ts`:

```typescript
import { browseFn } from 'browsefn';

async function test() {
  const browse = browseFn({
    web: { defaultProvider: 'cheerio' }
  });

  console.log('Testing web scraping...');
  const page = await browse.web.getPage('https://example.com');
  console.log('✓ Title:', page.metadata.title);

  console.log('\nTesting geocoding...');
  const browse2 = browseFn({
    geo: {
      providers: {
        nominatim: { userAgent: 'Test/1.0' }
      }
    }
  });
  
  const address = await browse2.geo.reverseGeocode({
    lat: 40.7128,
    lng: -74.0060
  });
  console.log('✓ Address:', address.address.city);

  console.log('\n✅ All tests passed!');
}

test().catch(console.error);
```

Run it:

```bash
npx tsx test.ts
```

## Next Steps

1. Read the [full specification](../SPEC.md)
2. Explore the [examples](../ts-sdk/examples/)
3. Check the [implementation guide](./IMPLEMENTATION.md)
4. Join the community and contribute!

## Troubleshooting

### Puppeteer Installation Issues

If Puppeteer fails to install:

```bash
npm install puppeteer --ignore-scripts
PUPPETEER_SKIP_DOWNLOAD=true npm install puppeteer
```

### Rate Limiting

If you hit rate limits:

```typescript
const browse = browseFn({
  rateLimit: {
    perProvider: {
      nominatim: { requests: 1, window: 2000 } // Slower
    }
  }
});
```

### Cache Not Working

Verify cache is enabled:

```typescript
const browse = browseFn({
  cache: {
    enabled: true,
    defaultTTL: 3600000
  }
});

// Check cache stats
const stats = await browse.cache?.getStats();
console.log('Cache enabled:', !!browse.cache);
console.log('Hit rate:', stats?.hitRate);
```

## API Keys

### Get Free API Keys

**Unsplash**:
1. Go to https://unsplash.com/developers
2. Create an account
3. Create a new application
4. Copy the Access Key
5. Free tier: 50 requests/hour

**Pixabay**:
1. Go to https://pixabay.com/api/docs/
2. Create an account
3. Get your API key
4. Free tier: Unlimited

**Pexels**:
1. Go to https://www.pexels.com/api/
2. Create an account
3. Generate API key
4. Free tier: 200 requests/hour

**Nominatim** (OpenStreetMap):
- No API key required!
- Just provide a user agent
- Free tier: 1 request/second

## Need Help?

- Check the [SPEC.md](../SPEC.md) for full documentation
- Open an issue on [GitHub](https://github.com/21nCo/super-functions/issues)
- Email: hello@21n.org
