# BrowseFn TypeScript

The TypeScript package published from this directory is `browsefn`.

## Install

```bash
npm install browsefn
```

Optional peer dependencies:

```bash
npm install puppeteer
npm install playwright
```

## Public Exports

```ts
import {
  browseFn,
  BrowseFn,
  CheerioProvider,
  FirecrawlProvider,
  JinaProvider,
  PuppeteerProvider,
  PlaywrightProvider,
  UnsplashProvider,
  PixabayProvider,
  PexelsProvider,
  NominatimProvider,
  GoogleMapsProvider,
  MapboxProvider,
  createBrowseFnRouter,
} from 'browsefn';
```

The package also exports the documented config/result types and the canonical provider-registry helpers.

## Canonical Provider IDs

- Web: `cheerio`, `puppeteer`, `playwright`, `firecrawl`, `jina`
- Images: `unsplash`, `pixabay`, `pexels`
- Geo: `nominatim`, `google-maps`, `mapbox`

Accepted aliases normalize before internal use. For example, `googleMaps` is accepted as input and emitted as `google-maps`.

## Example

```ts
import { browseFn } from 'browsefn';

const browse = browseFn({
  web: {
    defaultProvider: 'cheerio',
    fallbackChain: ['cheerio'],
  },
  cache: {
    enabled: true,
    ttl: 60_000,
  },
});

const page = await browse.web.getPage('https://example.com', {
  format: 'markdown',
  includeLinks: true,
  includeImages: true,
});

console.log(page.provider);
console.log(page.links?.length ?? 0);
console.log(page.images?.length ?? 0);
```

## Repo-Root Verification

```bash
npm --prefix browsefn/typescript run build
npm --prefix browsefn/typescript run typecheck
npm --prefix browsefn/typescript run test -- --run web-scraper web-providers image-browser image-providers geocoder geo-providers
```

## Related Files

- [Package overview](../README.md)
- [Examples](./examples/)
