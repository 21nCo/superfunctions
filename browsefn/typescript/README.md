# BrowseFn

> Self-hosted web browsing and data extraction platform for developers

BrowseFn is a comprehensive developer-first browsing solution that combines web scraping, batch metadata extraction, image browsing/downloading, and geolocation services into a single self-hosted platform.

## Features

- **Web Scraping & Crawling**: Multiple provider support (Firecrawl, Puppeteer, Playwright, Cheerio, Jina AI)
- **Batch Metadata Extraction**: Extract metadata from multiple URLs efficiently
- **Image Search & Download**: Browse and download images from Unsplash, Pixabay, Pexels
- **Geolocation Services**: Geocoding, reverse geocoding, and place search
- **Provider-Agnostic**: Unified interface with automatic fallback
- **Performance**: Built-in caching, rate limiting, and retry logic
- **Type-Safe**: Full TypeScript support with type inference

## Installation

```bash
npm install browsefn
```

### Optional Dependencies

```bash
# For Puppeteer support
npm install puppeteer

# For Playwright support
npm install playwright
```

## Quick Start

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

## Documentation

See [SPEC.md](../SPEC.md) for full API documentation.

## License

Apache-2.0
