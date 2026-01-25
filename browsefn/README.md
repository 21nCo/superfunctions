# BrowseFn

> Self-hosted web browsing and data extraction platform for developers

BrowseFn is a comprehensive developer-first solution that combines web scraping, batch metadata extraction, image browsing/downloading, and geolocation services into a single self-hosted platform with a unified interface and multiple provider support.

## Features

### 🌐 Web Scraping & Crawling

- **Multiple Providers**: Cheerio (lightweight), Puppeteer, Playwright
- **Flexible Output**: HTML, Markdown, Text, or JSON formats
- **JavaScript Support**: Render dynamic content with browser providers
- **Advanced Filtering**: CSS selector-based inclusion/exclusion
- **Metadata Extraction**: OpenGraph, Twitter Cards, JSON-LD
- **Batch Processing**: Extract metadata from multiple URLs efficiently
- **Screenshots**: Capture page screenshots (with Puppeteer/Playwright)

### 🖼️ Image Search & Download

- **Multiple Sources**: Unsplash, Pixabay, Pexels
- **Smart Filtering**: Size, orientation, color, license
- **Batch Download**: Download multiple images with concurrency control
- **Free Tiers**: Leverage free API tiers across providers

### 📍 Geolocation Services

- **Reverse Geocoding**: Convert coordinates to addresses
- **Forward Geocoding**: Convert addresses to coordinates
- **Free Provider**: OpenStreetMap/Nominatim (no API key required)
- **Detailed Results**: Street, city, state, country, postal code

### 🚀 Performance & Reliability

- **Caching**: Built-in response caching with TTL
- **Rate Limiting**: Per-provider and global rate limits
- **Automatic Fallback**: Seamless provider switching on failure
- **Retry Logic**: Configurable retry with exponential backoff
- **Metrics & Logging**: Track performance and debug issues

## Quick Start

### Installation

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

// Scrape a webpage
const page = await browse.web.getPage('https://example.com', {
  format: 'markdown'
});

console.log(page.content);
```

### With Puppeteer (Optional)

```bash
npm install puppeteer
```

```typescript
const browse = browseFn({
  web: {
    defaultProvider: 'puppeteer',
    providers: {
      puppeteer: { headless: true }
    }
  }
});

const page = await browse.web.getPage('https://example.com', {
  javascript: true,
  screenshot: true
});
```

## Directory Structure

```
browsefn/
├── ts-sdk/              # TypeScript SDK
│   ├── src/             # Source code
│   ├── examples/        # Usage examples
│   └── README.md
├── python/              # Python SDK (coming soon)
│   └── README.md
├── SPEC.md              # Full specification
└── .conduct/            # Implementation documentation
```

## Documentation

- **[Full Specification](./SPEC.md)** - Complete API documentation and feature list
- **[TypeScript SDK](./ts-sdk/README.md)** - TypeScript-specific documentation
- **[Implementation Guide](./.conduct/IMPLEMENTATION.md)** - Implementation details
- **[Examples](./ts-sdk/examples/)** - Working code examples

## Examples

### Web Scraping

```typescript
// Simple scraping
const page = await browse.web.getPage('https://example.com');

// With options
const page = await browse.web.getPage('https://example.com', {
  format: 'markdown',
  selectors: {
    include: ['main', 'article'],
    exclude: ['.ads', '.footer']
  }
});

// Batch metadata extraction
const metadata = await browse.web.getMultipleMetadata([
  'https://example.com/page1',
  'https://example.com/page2'
], {
  fields: ['title', 'description', 'image'],
  concurrency: 5
});
```

### Image Search

```typescript
const browse = browseFn({
  images: {
    providers: {
      unsplash: { apiKey: process.env.UNSPLASH_KEY }
    }
  }
});

const results = await browse.images.search('mountain landscape', {
  orientation: 'landscape',
  perPage: 20,
  filters: { minWidth: 1920 }
});

// Download images
await browse.images.downloadBatch(
  results.results.map(img => img.url),
  { destination: './downloads', concurrency: 3 }
);
```

### Geocoding

```typescript
const browse = browseFn({
  geo: {
    providers: {
      nominatim: {
        userAgent: 'MyApp/1.0'
      }
    }
  }
});

// Reverse geocoding
const address = await browse.geo.reverseGeocode({
  lat: 40.7128,
  lng: -74.0060
});

// Forward geocoding
const locations = await browse.geo.geocode('New York City');
```

## Provider Support

### Web Scraping

| Provider | JavaScript | Screenshots | Free | Requires Install |
|----------|-----------|-------------|------|------------------|
| Cheerio | ❌ | ❌ | ✅ | No |
| Puppeteer | ✅ | ✅ | ✅ | Yes (optional) |
| Playwright | ✅ | ✅ | ✅ | Yes (optional) |

### Images

| Provider | Free Tier | API Key Required |
|----------|-----------|------------------|
| Unsplash | 50/hour | Yes |
| Pixabay | Unlimited | Yes |
| Pexels | 200/hour | Yes |

### Geolocation

| Provider | Free Tier | API Key Required |
|----------|-----------|------------------|
| Nominatim | 1/sec | No |

## Configuration

### Full Configuration Example

```typescript
const browse = browseFn({
  web: {
    defaultProvider: 'cheerio',
    providers: {
      cheerio: { timeout: 10000 },
      puppeteer: { headless: true },
      playwright: { browser: 'chromium' }
    },
    fallbackChain: ['cheerio', 'puppeteer']
  },
  images: {
    defaultProvider: 'unsplash',
    providers: {
      unsplash: { apiKey: 'xxx' },
      pixabay: { apiKey: 'xxx' },
      pexels: { apiKey: 'xxx' }
    }
  },
  geo: {
    defaultProvider: 'nominatim',
    providers: {
      nominatim: {
        endpoint: 'https://nominatim.openstreetmap.org',
        userAgent: 'MyApp/1.0'
      }
    }
  },
  cache: {
    enabled: true,
    defaultTTL: 3600000, // 1 hour
    maxSize: 1000
  },
  rateLimit: {
    global: { requests: 100, window: 60000 },
    perProvider: {
      nominatim: { requests: 1, window: 1000 }
    }
  },
  retry: {
    enabled: true,
    maxAttempts: 3,
    delay: 1000,
    backoff: 'exponential'
  }
});
```

## API Overview

### Web Scraping

- `browse.web.getPage(url, options)` - Scrape a single page
- `browse.web.getMultipleMetadata(urls, options)` - Extract metadata from multiple URLs
- `browse.web.listProviders()` - List available providers

### Image Search

- `browse.images.search(query, options)` - Search for images
- `browse.images.download(url, options)` - Download a single image
- `browse.images.downloadBatch(urls, options)` - Download multiple images
- `browse.images.listProviders()` - List available providers

### Geocoding

- `browse.geo.reverseGeocode(location, options)` - Coordinates to address
- `browse.geo.geocode(address, options)` - Address to coordinates
- `browse.geo.search(options)` - Search for places
- `browse.geo.getPlaceDetails(placeId, options)` - Get place details
- `browse.geo.listProviders()` - List available providers

### Utilities

- `browse.getMetrics(options)` - Get performance metrics
- `browse.getRateLimitStatus(provider)` - Check rate limit status
- `browse.getLogs(filter)` - Get request logs
- `browse.clearCache()` - Clear cache
- `browse.on(event, handler)` - Register event handler

## Events

```typescript
browse.on('request', (event) => {
  console.log('Request:', event.url);
});

browse.on('response', (event) => {
  console.log('Response:', event.duration + 'ms');
});

browse.on('error', (event) => {
  console.error('Error:', event.error);
});

browse.on('cache.hit', (event) => {
  console.log('Cache hit:', event.key);
});

browse.on('rateLimit', (event) => {
  console.warn('Rate limit:', event.provider);
});
```

## Development

### Building

```bash
cd ts-sdk
npm install
npm run build
```

### Testing

```bash
npm test
```

### Running Examples

```bash
cd ts-sdk
npm run build

# Basic web scraping (no dependencies)
node examples/basic-web-scraping.js

# With Puppeteer (requires: npm install puppeteer)
node examples/with-puppeteer.js

# Image search (requires UNSPLASH_ACCESS_KEY)
UNSPLASH_ACCESS_KEY=xxx node examples/image-search.js

# Geocoding (no API key required)
node examples/geocoding.js
```

## Python SDK

The Python SDK is planned for a future release. See [python/README.md](./python/README.md) for updates.

## Philosophy

### Self-Hosted First
No vendor lock-in. Run anywhere - your laptop, server, or cloud.

### Provider-Agnostic
Unified interface across providers. Switch providers without changing code.

### Developer Experience
Simple SDK that works locally with minimal configuration.

### Cost-Aware
Optimize for free tiers with automatic fallback strategies.

## License

Apache-2.0

## Contributing

See the main [superfunctions repository](https://github.com/21nCo/super-functions) for contribution guidelines.

## Support

- **Issues**: [GitHub Issues](https://github.com/21nCo/super-functions/issues)
- **Email**: hello@21n.org
- **Docs**: See [SPEC.md](./SPEC.md) for complete documentation

## Related Superfunctions

- **[SearchFn](../searchfn/)** - Browser-first full-text search
- **[CacheFn](../cachefn/)** - Multi-tier caching
- **[PlugFn](../plugfn/)** - Integration platform
- **[AuthFn](../authfn/)** - Authentication & API keys

---

Built with ❤️ by [21n](https://github.com/21nCo)
