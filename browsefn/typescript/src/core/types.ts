/**
 * Core types and interfaces for BrowseFn
 */

// ===== Common Types =====

export type Provider = string;
export type CanonicalWebProviderId =
  | 'cheerio'
  | 'puppeteer'
  | 'playwright'
  | 'firecrawl'
  | 'jina';
export type CanonicalImageProviderId =
  | 'unsplash'
  | 'pixabay'
  | 'pexels';
export type CanonicalGeoProviderId =
  | 'nominatim'
  | 'google-maps'
  | 'mapbox';

export interface ProviderConfig {
  apiKey?: string;
  endpoint?: string;
  timeout?: number;
  userAgent?: string;
  rateLimit?: RateLimitConfig;
  [key: string]: any;
}

export interface RateLimitConfig {
  requests: number;
  window: number; // milliseconds
}

export interface CacheConfig {
  /** Persistent-cache identity; separate identities never share entries. */
  name?: string;
  directory?: string;
  database?: import("@superfunctions/db").Adapter;
  indexedDB?: IDBFactory;
  enabled: boolean;
  ttl?: number;
  defaultTTL?: number;
  storage?: 'memory' | 'indexeddb' | 'file' | 'database';
  maxSize?: number;
  keyGenerator?: (method: string, url: string, options: any) => string;
}

export interface RetryConfig {
  enabled: boolean;
  maxAttempts: number;
  delay: number;
  backoff: 'linear' | 'exponential';
  retryOn?: number[];
  onRetry?: (attempt: number, error: Error) => void;
}

// ===== Events =====

export type BrowseFnEvent =
  | 'request'
  | 'response'
  | 'error'
  | 'cache.hit'
  | 'cache.miss'
  | 'rateLimit'
  | 'provider.fallback';

export interface EventData {
  event: BrowseFnEvent;
  operation?: string;
  method?: string;
  url?: string;
  provider?: string;
  duration?: number;
  error?: {
    name?: string;
    message: string;
    code?: string;
    statusCode?: number;
  };
  key?: string;
  timestamp: number;
  requestId?: string;
  cached?: boolean;
  outcome?: 'success' | 'error' | 'fallback' | 'rate-limited';
  fallbackFrom?: string;
  fallbackTo?: string;
  retryAttempt?: number;
  details?: Record<string, unknown>;
}

export type EventHandler = (event: EventData) => void;

// ===== Metrics =====

export interface Metrics {
  totalRequests: number;
  successRate: number;
  avgResponseTime: number;
  byProvider: ProviderMetrics[];
  cacheHitRate?: number;
}

export interface ProviderMetrics {
  name: string;
  requests: number;
  successes: number;
  failures: number;
  avgResponseTime: number;
}

export interface RateLimitStatus {
  remaining: number;
  resetAt: number;
  limit: number;
  allowed?: boolean;
  provider?: string;
  retryAfterMs?: number;
}

// ===== Web Scraping Types =====

export interface WebConfig {
  /** Round-robin target User-Agent values; explicit request headers take precedence. */
  userAgents?: string[];
  defaultProvider?: string;
  providers?: Record<string, ProviderConfig>;
  fallbackChain?: string[];
  fallbackOnErrors?: string[];
  cache?: CacheConfig;
  rateLimit?: RateLimitConfig;
}

export interface DestinationSecurity {
  /** Maximum page transport and returned UTF-8 content bytes. */
  maxResponseBytes?: number;
  /** Maximum image download, transform input and encoded output bytes. */
  maxDownloadBytes?: number;
  /** Maximum followed redirects; zero rejects the first redirect. */
  maxRedirects?: number;
  /** Exact private-host exceptions; does not restrict other public hosts. */
  allowedHosts?: string[];
  /** Exact deny rules; take precedence over every private-host opt-in. */
  blockedHosts?: string[];
  /** Explicit trusted in-process opt-in. HTTP routes always override this. */
  allowPrivateHosts?: boolean;
}

export interface GetPageOptions {
  security?: DestinationSecurity;
  provider?: string;
  format?: 'html' | 'markdown' | 'text' | 'json';
  includeLinks?: boolean;
  includeImages?: boolean;
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

export interface PageMetadata {
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

export interface PageResult {
  url: string;
  content: string;
  metadata: PageMetadata;
  links?: string[];
  images?: string[];
  screenshot?: Uint8Array;
  provider: string;
  cached?: boolean;
  duration?: number;
}

export interface MetadataOptions {
  security?: DestinationSecurity;
  fields?: Array<'title' | 'description' | 'image' | 'author' | 'published' | 'keywords' | 'favicon'>;
  timeout?: number;
  concurrency?: number;
  cache?: boolean;
  maxBatchOverride?: number;
  onProgress?: (completed: number, total: number) => void;
}

export interface MetadataResult {
  success: boolean;
  data?: PageMetadata;
  error?: string;
  cached?: boolean;
  duration?: number;
  provider?: string;
}

export interface ProviderCapabilities {
  formats: Array<'html' | 'markdown' | 'text' | 'json'>;
  javascript: boolean;
  screenshots: boolean;
  cookies: boolean;
  headers: boolean;
  selectors?: boolean;
  proxy?: boolean;
  scriptExecution?: boolean;
}

export interface WebProvider {
  name: string;
  capabilities: ProviderCapabilities;
  getPage(url: string, options: GetPageOptions): Promise<PageResult>;
  scrape?<T>(
    url: string,
    options: GetPageOptions & { script: (page: unknown) => Promise<T> | T }
  ): Promise<T>;
  isAvailable(): Promise<boolean>;
}

// ===== Image Types =====

export interface ImageConfig {
  defaultProvider?: string;
  providers?: Record<string, ProviderConfig>;
  cache?: CacheConfig;
}

export interface ImageSearchOptions {
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

export interface ImageResult {
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

export interface ImageSearchResult {
  query: string;
  total: number;
  page: number;
  perPage: number;
  results: ImageResult[];
  nextPage?: number;
  provider: string;
}

export interface ImageDownloadOptions {
  security?: DestinationSecurity;
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
  allowPrivateHosts?: boolean;
  maxRedirects?: number;
  maxPayloadBytes?: number;
  onProgress?: (bytes: number, total: number) => void;
}

export interface ImageMetadata {
  format: string;
  width: number;
  height: number;
  size: number;
  colorSpace?: string;
  hasAlpha?: boolean;
  exif?: Record<string, any>;
}

export interface DownloadResult {
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

export interface ImageProvider {
  name: string;
  search(query: string, options: ImageSearchOptions): Promise<ImageSearchResult>;
  download?(url: string, options: ImageDownloadOptions): Promise<DownloadResult>;
  isAvailable(): Promise<boolean>;
}

// ===== Geo Types =====

export interface GeoConfig {
  defaultProvider?: string;
  providers?: Record<string, ProviderConfig>;
  cache?: CacheConfig;
}

export interface GeoLocation {
  lat: number;
  lng: number;
}

export interface GeoAddress {
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

export interface ReverseGeocodeResult {
  location: GeoLocation;
  address: GeoAddress;
  accuracy?: number;
  placeId?: string;
  provider: string;
  cached?: boolean;
}

export interface GeocodeOptions {
  provider?: string;
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

export interface GeoSearchOptions {
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

export interface GeoPlace {
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

export interface GeoProvider {
  name: string;
  reverseGeocode(location: GeoLocation): Promise<ReverseGeocodeResult>;
  geocode(address: string, options: GeocodeOptions): Promise<ReverseGeocodeResult[]>;
  search?(options: GeoSearchOptions): Promise<GeoPlace[]>;
  getPlaceDetails?(placeId: string, fields?: string[]): Promise<GeoPlace>;
  isAvailable(): Promise<boolean>;
}

// ===== Main Config =====

export type SecurityConfig = DestinationSecurity;

export interface BrowseFnConfig {
  security?: SecurityConfig;
  web?: WebConfig;
  images?: ImageConfig;
  geo?: GeoConfig;
  cache?: CacheConfig;
  rateLimit?: {
    global?: RateLimitConfig;
    perProvider?: Record<string, RateLimitConfig>;
  };
  retry?: RetryConfig;
}
