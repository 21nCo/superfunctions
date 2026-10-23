# BrowseFn Full Specification

> Comprehensive self-hosted web browsing and data extraction platform for developers

## Overview

BrowseFn is a developer-first browsing solution that combines web scraping, batch metadata extraction, image browsing/downloading, and geolocation services into a single self-hosted platform. It provides a unified interface with multiple provider support, enabling developers to switch between providers without changing code.

**Version**: 1.0.0  
**Target Release**: Q2 2026  
**Status**: Specification

## Core Philosophy

- **Self-hosted first**: No vendor lock-in, run anywhere
- **Provider-agnostic**: Unified interface, multiple providers
- **Developer experience**: Simple SDK, works locally, minimal configuration
- **Comprehensive**: Web scraping, image browsing, geo services in one tool
- **Performance**: Efficient caching, rate limiting, and resource management
- **Type-safe**: First-class TypeScript support with full type inference
- **Extensible**: Easy to add new providers and capabilities
- **Composable**: Built for the super-functions ecosystem
- **Cost-aware**: Optimize for free tiers, fallback strategies

## Architecture

```
browsefn/
├── ts-sdk/
│   ├── src/
│   │   ├── core/
│   │   │   ├── browse-fn.ts          # Main SDK entry
│   │   │   ├── provider-manager.ts   # Provider orchestration
│   │   │   ├── rate-limiter.ts       # Rate limiting
│   │   │   └── cache-manager.ts      # Response caching
│   │   ├── web/
│   │   │   ├── scraper.ts            # Web scraping interface
│   │   │   ├── metadata.ts           # Batch metadata extraction
│   │   │   ├── providers/
│   │   │   │   ├── firecrawl.ts      # Firecrawl provider
│   │   │   │   ├── puppeteer.ts      # Puppeteer provider
│   │   │   │   ├── playwright.ts     # Playwright provider
│   │   │   │   ├── cheerio.ts        # Cheerio provider
│   │   │   │   ├── jina.ts           # Jina AI provider
│   │   │   │   └── custom.ts         # Custom provider interface
│   │   │   └── types.ts
│   │   ├── images/
│   │   │   ├── browser.ts            # Image browsing interface
│   │   │   ├── downloader.ts         # Image downloading
│   │   │   ├── providers/
│   │   │   │   ├── unsplash.ts       # Unsplash provider
│   │   │   │   ├── pixabay.ts        # Pixabay provider
│   │   │   │   ├── pexels.ts         # Pexels provider
│   │   │   │   └── custom.ts
│   │   │   └── types.ts
│   │   ├── geo/
│   │   │   ├── geocoder.ts           # Geocoding interface
│   │   │   ├── search.ts             # Geo search
│   │   │   ├── providers/
│   │   │   │   ├── google-maps.ts    # Google Maps provider
│   │   │   │   ├── mapbox.ts         # Mapbox provider
│   │   │   │   ├── nominatim.ts      # Nominatim (OSM) provider
│   │   │   │   └── custom.ts
│   │   │   └── types.ts
│   │   ├── middleware/
│   │   │   ├── retry.ts              # Retry logic
│   │   │   ├── fallback.ts           # Provider fallback
│   │   │   ├── logging.ts            # Request logging
│   │   │   └── metrics.ts            # Performance metrics
│   │   ├── storage/
│   │   │   ├── cache-storage.ts      # Cache implementation
│   │   │   ├── queue-storage.ts      # Request queue
│   │   │   └── adapters/
│   │   │       ├── memory.ts
│   │   │       ├── indexeddb.ts
│   │   │       ├── file.ts
│   │   │       └── database.ts
│   │   └── utils/
│   │       ├── url-utils.ts
│   │       ├── html-utils.ts
│   │       ├── image-utils.ts
│   │       └── validation.ts
│   └── examples/
├── dashboard/                        # Provider management UI
└── cli/                             # Command-line tools
```

## Core Features

### 1. Web Scraping & Crawling

#### Basic Web Scraping

```typescript
import { browseFn } from 'browsefn';

const browse = browseFn({
  web: {
    defaultProvider: 'firecrawl',
    providers: {
      firecrawl: {
        apiKey: process.env.FIRECRAWL_API_KEY
      },
      puppeteer: {
        headless: true,
        timeout: 30000
      }
    },
    cache: {
      enabled: true,
      ttl: 3600000,
      storage: 'indexeddb'
    },
    rateLimit: {
      requests: 100,
      window: 60000
    }
  }
});

const page = await browse.web.getPage('https://example.com', {
  format: 'markdown',
  includeImages: true,
  includeLinks: true,
  waitFor: 'networkidle'
});

console.log(page.content);
console.log(page.metadata);
console.log(page.links);
```

#### Advanced Scraping Options

```typescript
interface GetPageOptions {
  provider?: string;
  format?: 'html' | 'markdown' | 'text' | 'json';
  selectors?: {
    include?: string[];
    exclude?: string[];
  };
  waitFor?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
  headers?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  javascript?: boolean;
  mobile?: boolean;
  screenshot?: boolean | {
    fullPage?: boolean;
    format?: 'png' | 'jpeg';
    quality?: number;
  };
  proxy?: string;
  cache?: boolean | {
    ttl?: number;
    key?: string;
  };
  retry?: {
    count: number;
    delay: number;
  };
}

const complexPage = await browse.web.getPage('https://example.com/product', {
  provider: 'puppeteer',
  format: 'json',
  selectors: {
    include: ['.product-info', '.reviews'],
    exclude: ['.ads', '.footer']
  },
  waitFor: 'networkidle',
  timeout: 30000,
  javascript: true,
  screenshot: {
    fullPage: true,
    format: 'png'
  },
  cache: {
    ttl: 1800000,
    key: 'product-page-123'
  },
  retry: {
    count: 3,
    delay: 1000
  }
});
```

#### Multi-Provider Support

```typescript
const browse = browseFn({
  web: {
    providers: {
      firecrawl: { apiKey: process.env.FIRECRAWL_API_KEY },
      puppeteer: { headless: true },
      playwright: { browser: 'chromium' },
      cheerio: { timeout: 10000 },
      jina: { apiKey: process.env.JINA_API_KEY }
    },
    fallbackChain: ['firecrawl', 'jina', 'puppeteer', 'cheerio']
  }
});

const page = await browse.web.getPage('https://example.com');
```

#### Custom Scraping Logic

```typescript
const customResult = await browse.web.scrape('https://example.com', {
  provider: 'puppeteer',
  script: async (page) => {
    const title = await page.$eval('h1', el => el.textContent);
    const prices = await page.$$eval('.price', els => 
      els.map(el => el.textContent)
    );
    
    await page.click('#load-more');
    await page.waitForSelector('.additional-content');
    
    const moreData = await page.$eval('.additional-content', el => el.innerHTML);
    
    return {
      title,
      prices,
      moreData
    };
  }
});
```

### 2. Batch Metadata Extraction

#### Bulk URL Metadata

```typescript
interface MetadataOptions {
  fields?: Array<'title' | 'description' | 'image' | 'author' | 'published' | 'keywords' | 'favicon'>;
  timeout?: number;
  concurrency?: number;
  cache?: boolean;
  onProgress?: (completed: number, total: number) => void;
}

const urls = [
  'https://example.com/article1',
  'https://example.com/article2',
  'https://example.com/article3'
];

const metadata = await browse.web.getMultipleMetadata(urls, {
  fields: ['title', 'description', 'image', 'author', 'published'],
  concurrency: 5,
  timeout: 10000,
  cache: true,
  onProgress: (completed, total) => {
    console.log(`Progress: ${completed}/${total}`);
  }
});

metadata.forEach((meta, index) => {
  if (meta.success) {
    console.log(`${urls[index]}: ${meta.data.title}`);
  } else {
    console.error(`${urls[index]}: ${meta.error}`);
  }
});
```

#### Metadata Result Schema

```typescript
interface PageMetadata {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  author?: string;
  published?: Date;
  keywords?: string[];
  favicon?: string;
  siteName?: string;
  locale?: string;
  type?: string;
  openGraph?: {
    title?: string;
    description?: string;
    image?: string;
    type?: string;
    url?: string;
  };
  twitter?: {
    card?: string;
    site?: string;
    title?: string;
    description?: string;
    image?: string;
  };
  jsonLd?: any[];
}

interface MetadataResult {
  success: boolean;
  data?: PageMetadata;
  error?: string;
  cached?: boolean;
  duration?: number;
  provider?: string;
}
```

### 3. Image Browsing & Search

#### Image Search

```typescript
const browse = browseFn({
  images: {
    defaultProvider: 'unsplash',
    providers: {
      unsplash: {
        apiKey: process.env.UNSPLASH_ACCESS_KEY,
        rateLimit: { requests: 50, window: 3600000 }
      },
      pixabay: {
        apiKey: process.env.PIXABAY_API_KEY
      },
      pexels: {
        apiKey: process.env.PEXELS_API_KEY
      }
    }
  }
});

const images = await browse.images.search('mountain landscape', {
  provider: 'unsplash',
  page: 1,
  perPage: 20,
  orientation: 'landscape',
  color: 'blue',
  orderBy: 'relevant',
  filters: {
    minWidth: 1920,
    minHeight: 1080,
    safeSearch: true
  }
});

console.log(`Found ${images.total} images`);
images.results.forEach(img => {
  console.log(`${img.description} - ${img.url}`);
});
```

#### Image Search Options

```typescript
interface ImageSearchOptions {
  provider?: string;
  page?: number;
  perPage?: number;
  orientation?: 'landscape' | 'portrait' | 'square';
  color?: string;
  orderBy?: 'relevant' | 'latest' | 'popular';
  filters?: {
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
    safeSearch?: boolean;
    license?: 'free' | 'premium' | 'editorial';
  };
  cache?: boolean;
}

interface ImageResult {
  id: string;
  url: string;
  thumbnail: string;
  width: number;
  height: number;
  description?: string;
  alt?: string;
  author?: {
    name: string;
    url?: string;
  };
  source: {
    provider: string;
    url: string;
  };
  license?: string;
  tags?: string[];
  downloads?: {
    small?: string;
    medium?: string;
    large?: string;
    original?: string;
  };
}

interface ImageSearchResult {
  query: string;
  total: number;
  page: number;
  perPage: number;
  results: ImageResult[];
  nextPage?: number;
  provider: string;
}
```

### 4. Image Downloading

#### Download Images

```typescript
const downloadResult = await browse.images.download(
  'https://unsplash.com/photos/xyz',
  {
    destination: './downloads',
    filename: 'mountain-landscape.jpg',
    size: 'large',
    format: 'jpeg',
    quality: 90,
    onProgress: (bytes, total) => {
      console.log(`Downloaded: ${Math.round(bytes / total * 100)}%`);
    }
  }
);

console.log(`Saved to: ${downloadResult.path}`);
console.log(`Size: ${downloadResult.size} bytes`);
```

#### Batch Image Download

```typescript
const imageUrls = [
  'https://unsplash.com/photos/abc',
  'https://unsplash.com/photos/def',
  'https://unsplash.com/photos/ghi'
];

const downloads = await browse.images.downloadBatch(imageUrls, {
  destination: './downloads',
  concurrency: 3,
  size: 'medium',
  onProgress: (completed, total) => {
    console.log(`Downloaded ${completed}/${total} images`);
  },
  onError: (url, error) => {
    console.error(`Failed to download ${url}: ${error}`);
  }
});

downloads.forEach((result, index) => {
  if (result.success) {
    console.log(`${imageUrls[index]}: ${result.path}`);
  }
});
```

#### Download Options

```typescript
interface ImageDownloadOptions {
  destination?: string;
  filename?: string;
  size?: 'small' | 'medium' | 'large' | 'original';
  format?: 'jpeg' | 'png' | 'webp';
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  watermark?: {
    text?: string;
    image?: string;
    position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
    opacity?: number;
  };
  metadata?: boolean;
  overwrite?: boolean;
  onProgress?: (bytes: number, total: number) => void;
}

interface DownloadResult {
  success: boolean;
  path?: string;
  size?: number;
  format?: string;
  width?: number;
  height?: number;
  metadata?: ImageMetadata;
  error?: string;
  duration?: number;
}
```

### 5. Geolocation Services

#### Reverse Geocoding (Coordinates to Address)

```typescript
const browse = browseFn({
  geo: {
    defaultProvider: 'nominatim',
    providers: {
      nominatim: {
        endpoint: 'https://nominatim.openstreetmap.org',
        userAgent: 'MyApp/1.0'
      },
      googleMaps: {
        apiKey: process.env.GOOGLE_MAPS_API_KEY
      },
      mapbox: {
        apiKey: process.env.MAPBOX_API_KEY
      }
    }
  }
});

const address = await browse.geo.reverseGeocode({
  lat: 40.7128,
  lng: -74.0060,
  provider: 'nominatim'
});

console.log(address.formatted);
console.log(address.city);
console.log(address.country);
```

#### Address Result Schema

```typescript
interface GeoLocation {
  lat: number;
  lng: number;
}

interface GeoAddress {
  formatted: string;
  street?: string;
  streetNumber?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  countryCode?: string;
  neighborhood?: string;
  district?: string;
  region?: string;
}

interface ReverseGeocodeResult {
  location: GeoLocation;
  address: GeoAddress;
  accuracy?: number;
  placeId?: string;
  provider: string;
  cached?: boolean;
}
```

#### Forward Geocoding (Address to Coordinates)

```typescript
const locations = await browse.geo.geocode('1600 Amphitheatre Parkway, Mountain View, CA', {
  provider: 'googleMaps',
  limit: 5,
  bounds?: {
    sw: { lat: 37.0, lng: -122.5 },
    ne: { lat: 38.0, lng: -121.5 }
  },
  components?: {
    country: 'US',
    postalCode: '94043'
  }
});

locations.forEach(loc => {
  console.log(`${loc.address.formatted}: ${loc.location.lat}, ${loc.location.lng}`);
});
```

#### Geo Search

```typescript
interface GeoSearchOptions {
  provider?: string;
  query: string;
  center?: GeoLocation;
  radius?: number;
  types?: Array<'address' | 'city' | 'country' | 'poi' | 'postcode'>;
  language?: string;
  limit?: number;
  bounds?: {
    sw: GeoLocation;
    ne: GeoLocation;
  };
  components?: {
    country?: string;
    postalCode?: string;
    locality?: string;
  };
  cache?: boolean;
}

const places = await browse.geo.search({
  query: 'coffee shops',
  center: { lat: 40.7128, lng: -74.0060 },
  radius: 5000,
  types: ['poi'],
  limit: 20
});

places.forEach(place => {
  console.log(`${place.name} - ${place.address.formatted}`);
  console.log(`Distance: ${place.distance}m`);
});
```

#### Place Details

```typescript
interface GeoPlace {
  id: string;
  name: string;
  location: GeoLocation;
  address: GeoAddress;
  types?: string[];
  distance?: number;
  rating?: number;
  reviews?: number;
  photos?: string[];
  website?: string;
  phone?: string;
  openingHours?: {
    open: boolean;
    periods?: Array<{
      open: { day: number; time: string };
      close: { day: number; time: string };
    }>;
  };
  provider: string;
}

const placeDetails = await browse.geo.getPlaceDetails('place-id-123', {
  provider: 'googleMaps',
  fields: ['name', 'address', 'rating', 'reviews', 'photos', 'openingHours']
});
```

### 6. Provider Management

#### Provider Configuration

```typescript
const browse = browseFn({
  web: {
    providers: {
      firecrawl: {
        apiKey: process.env.FIRECRAWL_API_KEY,
        rateLimit: { requests: 500, window: 60000 }
      },
      puppeteer: {
        headless: true,
        executablePath: '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    }
  },
  images: {
    providers: {
      unsplash: {
        apiKey: process.env.UNSPLASH_ACCESS_KEY,
        rateLimit: { requests: 50, window: 3600000 }
      }
    }
  },
  geo: {
    providers: {
      nominatim: {
        endpoint: 'https://nominatim.openstreetmap.org',
        userAgent: 'MyApp/1.0',
        rateLimit: { requests: 1, window: 1000 }
      }
    }
  }
});
```

#### Custom Provider Implementation

```typescript
import { WebProvider, ProviderCapabilities } from 'browsefn';

class CustomWebProvider implements WebProvider {
  name = 'custom-provider';
  capabilities: ProviderCapabilities = {
    formats: ['html', 'markdown', 'text'],
    javascript: true,
    screenshots: true,
    cookies: true,
    headers: true
  };
  
  async getPage(url: string, options: GetPageOptions): Promise<PageResult> {
    const response = await customScrapeAPI.fetch(url, {
      format: options.format || 'html',
      javascript: options.javascript,
      headers: options.headers
    });
    
    return {
      url,
      content: response.content,
      metadata: {
        title: response.title,
        description: response.description
      },
      provider: this.name
    };
  }
  
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const browse = browseFn({
  web: {
    providers: {
      custom: new CustomWebProvider()
    }
  }
});
```

### 7. Caching & Performance

#### Response Caching

```typescript
const browse = browseFn({
  cache: {
    enabled: true,
    storage: 'indexeddb',
    defaultTTL: 3600000,
    maxSize: 1000,
    keyGenerator: (method, url, options) => {
      return `${method}:${url}:${JSON.stringify(options)}`;
    }
  }
});

const page = await browse.web.getPage('https://example.com', {
  cache: true
});

await browse.cache.invalidate('https://example.com');

await browse.cache.clear();

const stats = await browse.cache.getStats();
console.log(`Hit rate: ${stats.hitRate}%`);
```

#### Rate Limiting

```typescript
const browse = browseFn({
  rateLimit: {
    global: {
      requests: 1000,
      window: 60000
    },
    perProvider: {
      firecrawl: {
        requests: 500,
        window: 60000
      },
      unsplash: {
        requests: 50,
        window: 3600000
      }
    }
  }
});

const rateLimitStatus = await browse.getRateLimitStatus('firecrawl');
console.log(`Remaining: ${rateLimitStatus.remaining}`);
console.log(`Reset at: ${new Date(rateLimitStatus.resetAt)}`);
```

### 8. Error Handling & Retry

#### Automatic Retry

```typescript
const browse = browseFn({
  retry: {
    enabled: true,
    maxAttempts: 3,
    delay: 1000,
    backoff: 'exponential',
    retryOn: [408, 429, 500, 502, 503, 504],
    onRetry: (attempt, error) => {
      console.log(`Retry attempt ${attempt}: ${error.message}`);
    }
  }
});
```

#### Provider Fallback

```typescript
const browse = browseFn({
  web: {
    fallbackChain: ['firecrawl', 'puppeteer', 'cheerio'],
    fallbackOnErrors: ['RATE_LIMIT', 'TIMEOUT', 'NOT_FOUND']
  }
});

const page = await browse.web.getPage('https://example.com');
```

#### Error Handling

```typescript
try {
  const page = await browse.web.getPage('https://example.com');
} catch (error) {
  if (error.code === 'RATE_LIMIT') {
    console.error(`Rate limit exceeded. Retry after ${error.retryAfter}ms`);
  } else if (error.code === 'TIMEOUT') {
    console.error('Request timed out');
  } else if (error.code === 'PROVIDER_ERROR') {
    console.error(`Provider error: ${error.provider}`);
  }
}
```

### 9. Monitoring & Analytics

#### Request Metrics

```typescript
const metrics = await browse.getMetrics({
  timeRange: 'last-24h',
  groupBy: 'provider'
});

console.log(`Total requests: ${metrics.totalRequests}`);
console.log(`Success rate: ${metrics.successRate}%`);
console.log(`Avg response time: ${metrics.avgResponseTime}ms`);

metrics.byProvider.forEach(provider => {
  console.log(`${provider.name}: ${provider.requests} requests`);
});
```

#### Event Logging

```typescript
browse.on('request', (event) => {
  console.log(`Request: ${event.method} ${event.url}`);
});

browse.on('response', (event) => {
  console.log(`Response: ${event.url} - ${event.duration}ms`);
});

browse.on('error', (event) => {
  console.error(`Error: ${event.url} - ${event.error.message}`);
});

browse.on('cache.hit', (event) => {
  console.log(`Cache hit: ${event.key}`);
});

browse.on('rateLimit', (event) => {
  console.warn(`Rate limit: ${event.provider}`);
});
```

### 10. Integration Examples

#### With SearchFn

```typescript
import { SearchFn } from 'searchfn';
import { browseFn } from 'browsefn';

const browse = browseFn();
const search = new SearchFn({ name: 'articles', fields: ['title', 'content'] });

async function indexWebPages(urls: string[]) {
  for (const url of urls) {
    const page = await browse.web.getPage(url, { format: 'markdown' });
    
    await search.add({
      id: url,
      fields: {
        title: page.metadata.title || '',
        content: page.content
      },
      store: {
        url,
        description: page.metadata.description,
        image: page.metadata.image
      }
    });
  }
}

const results = await search.search('typescript');
```

#### With CacheFn

```typescript
import { cacheFn } from 'cachefn';
import { browseFn } from 'browsefn';

const cache = cacheFn({ name: 'browse-cache', storage: 'indexeddb' });
const browse = browseFn({ cache: { enabled: false } });

async function getCachedPage(url: string) {
  return await cache.getOrFetch(url, {
    fetcher: async () => {
      return await browse.web.getPage(url);
    },
    ttl: 3600000,
    tags: ['webpage', 'browse']
  });
}
```

## Provider Support Matrix

### Web Scraping Providers

| Provider | JavaScript | Screenshots | Custom Headers | Cookies | Proxy | Cost |
|----------|-----------|------------|----------------|---------|-------|------|
| Firecrawl | ✅ | ✅ | ✅ | ✅ | ✅ | Paid |
| Puppeteer | ✅ | ✅ | ✅ | ✅ | ✅ | Free |
| Playwright | ✅ | ✅ | ✅ | ✅ | ✅ | Free |
| Cheerio | ❌ | ❌ | ✅ | ❌ | ✅ | Free |
| Jina AI | ✅ | ✅ | ✅ | ❌ | ❌ | Freemium |

### Image Providers

| Provider | Free Tier | Search | Download | Attribution Required |
|----------|-----------|---------|----------|---------------------|
| Unsplash | 50/hour | ✅ | ✅ | Yes |
| Pixabay | Unlimited | ✅ | ✅ | No |
| Pexels | 200/hour | ✅ | ✅ | No |

### Geo Providers

| Provider | Free Tier | Geocode | Reverse | Search | Details |
|----------|-----------|---------|---------|---------|---------|
| Nominatim | 1/sec | ✅ | ✅ | ✅ | Limited |
| Google Maps | $200/month | ✅ | ✅ | ✅ | ✅ |
| Mapbox | 100k/month | ✅ | ✅ | ✅ | ✅ |

## Performance Targets

- **Web scraping**: <5s for simple pages, <30s for JS-heavy pages
- **Metadata extraction**: <2s per URL
- **Image search**: <3s for 20 results
- **Image download**: <5s for medium-sized images
- **Geocoding**: <1s for cached, <3s for API calls
- **Cache hit rate**: >80% for repeated requests
- **Rate limit compliance**: 100% adherence to provider limits

## Security Considerations

- API key encryption at rest
- Proxy support for privacy
- User agent rotation
- Rate limit enforcement
- Request sanitization
- Response validation
- Secure storage of credentials

## Testing Strategy

- Unit tests for each provider
- Integration tests with real APIs (optional)
- Mock providers for testing
- Rate limit testing
- Fallback chain testing
- Cache functionality testing
- Error handling testing

## Documentation Requirements

### Core Documentation
- Getting started guide
- API reference
- Provider comparison guide
- Migration guides
- Best practices
- Troubleshooting

### Provider-Specific Guides
- Firecrawl setup
- Puppeteer/Playwright configuration
- Image provider setup
- Geo provider setup
- Custom provider development

### Advanced Topics
- Caching strategies
- Rate limiting
- Provider fallbacks
- Performance optimization
- Cost optimization

## License

Apache-2.0
