/**
 * BrowseFn - Self-hosted web browsing and data extraction platform
 */

// Main exports
export { BrowseFn, browseFn } from "./core/browse-fn.js";

// Core types
export type {
  BrowseFnConfig,
  BrowseFnEvent,
  EventHandler,
  EventData,
  Metrics,
  ProviderMetrics,
  RateLimitStatus,
  RateLimitConfig,
  CacheConfig,
  RetryConfig,
  ProviderConfig,
} from "./core/types.js";

// Web scraping types
export type {
  WebConfig,
  WebProvider,
  GetPageOptions,
  PageResult,
  PageMetadata,
  MetadataOptions,
  MetadataResult,
  ProviderCapabilities,
} from "./core/types.js";

// Image types
export type {
  ImageConfig,
  ImageProvider,
  ImageSearchOptions,
  ImageSearchResult,
  ImageResult,
  ImageDownloadOptions,
  DownloadResult,
  ImageMetadata,
} from "./core/types.js";

// Geo types
export type {
  GeoConfig,
  GeoProvider,
  GeoLocation,
  GeoAddress,
  ReverseGeocodeResult,
  GeocodeOptions,
  GeoSearchOptions,
  GeoPlace,
} from "./core/types.js";

// Web providers
export { CheerioProvider } from "./web/providers/cheerio.js";
export { PuppeteerProvider } from "./web/providers/puppeteer.js";
export { PlaywrightProvider } from "./web/providers/playwright.js";

// Image providers
export { UnsplashProvider } from "./images/providers/unsplash.js";
export { PixabayProvider } from "./images/providers/pixabay.js";
export { PexelsProvider } from "./images/providers/pexels.js";

// Geo providers
export { NominatimProvider } from "./geo/providers/nominatim.js";
export { GoogleMapsProvider } from "./geo/providers/google-maps.js";
export { MapboxProvider } from "./geo/providers/mapbox.js";

// Core classes
export { WebScraper } from "./web/scraper.js";
export { ImageBrowser } from "./images/browser.js";
export { Geocoder } from "./geo/geocoder.js";
export { CacheManager } from "./core/cache-manager.js";
export { RateLimiter } from "./core/rate-limiter.js";
export { ProviderManager } from "./core/provider-manager.js";

// Utilities
export * as urlUtils from "./utils/url-utils.js";
export * as htmlUtils from "./utils/html-utils.js";
export * as validation from "./utils/validation.js";

// Router
export { createBrowseFnRouter } from "./router/http-router.js";
