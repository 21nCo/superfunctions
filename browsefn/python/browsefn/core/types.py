from typing import Any, Dict, List, Optional, Union, Literal, Protocol, runtime_checkable
from datetime import datetime
from pydantic import BaseModel, Field

# ===== Common Types =====

Provider = str

class RateLimitConfig(BaseModel):
    requests: int
    window: int  # milliseconds

class CacheConfig(BaseModel):
    enabled: bool
    ttl: Optional[int] = None
    storage: Optional[Literal['memory', 'indexeddb', 'file', 'database']] = None
    max_size: Optional[int] = Field(None, alias="maxSize")
    # key_generator omitted as it's a function

class ProviderConfig(BaseModel):
    api_key: Optional[str] = Field(None, alias="apiKey")
    endpoint: Optional[str] = None
    timeout: Optional[int] = None
    rate_limit: Optional[RateLimitConfig] = Field(None, alias="rateLimit")
    extra: Dict[str, Any] = Field(default_factory=dict)

    class Config:
        extra = "allow"

class RetryConfig(BaseModel):
    enabled: bool
    max_attempts: int = Field(alias="maxAttempts")
    delay: int
    backoff: Literal['linear', 'exponential']
    retry_on: Optional[List[int]] = Field(None, alias="retryOn")
    # on_retry omitted as it's a function

# ===== Events =====

BrowseFnEvent = Literal[
    'request',
    'response',
    'error',
    'cache.hit',
    'cache.miss',
    'rateLimit',
    'provider.fallback'
]

class EventData(BaseModel):
    method: Optional[str] = None
    url: Optional[str] = None
    provider: Optional[str] = None
    duration: Optional[float] = None
    error: Optional[Exception] = None
    key: Optional[str] = None
    timestamp: float

    class Config:
        arbitrary_types_allowed = True

# ===== Metrics =====

class ProviderMetrics(BaseModel):
    name: str
    requests: int
    successes: int
    failures: int
    avg_response_time: float = Field(alias="avgResponseTime")

class Metrics(BaseModel):
    total_requests: int = Field(alias="totalRequests")
    success_rate: float = Field(alias="successRate")
    avg_response_time: float = Field(alias="avgResponseTime")
    by_provider: List[ProviderMetrics] = Field(alias="byProvider")
    cache_hit_rate: Optional[float] = Field(None, alias="cacheHitRate")

class RateLimitStatus(BaseModel):
    remaining: int
    reset_at: float = Field(alias="resetAt")
    limit: int

# ===== Web Scraping Types =====

class WebConfig(BaseModel):
    default_provider: Optional[str] = Field(None, alias="defaultProvider")
    providers: Optional[Dict[str, ProviderConfig]] = None
    fallback_chain: Optional[List[str]] = Field(None, alias="fallbackChain")
    fallback_on_errors: Optional[List[str]] = Field(None, alias="fallbackOnErrors")
    cache: Optional[CacheConfig] = None
    rate_limit: Optional[RateLimitConfig] = Field(None, alias="rateLimit")

class ScreenshotOptions(BaseModel):
    full_page: Optional[bool] = Field(None, alias="fullPage")
    format: Optional[Literal['png', 'jpeg']] = None
    quality: Optional[int] = None

class Selectors(BaseModel):
    include: Optional[List[str]] = None
    exclude: Optional[List[str]] = None

class CacheOptions(BaseModel):
    ttl: Optional[int] = None
    key: Optional[str] = None

class RetryOptions(BaseModel):
    count: int
    delay: int

class Cookie(BaseModel):
    name: str
    value: str
    domain: Optional[str] = None

class GetPageOptions(BaseModel):
    provider: Optional[str] = None
    format: Optional[Literal['html', 'markdown', 'text', 'json']] = None
    selectors: Optional[Selectors] = None
    wait_for: Optional[Literal['load', 'domcontentloaded', 'networkidle']] = Field(None, alias="waitFor")
    timeout: Optional[int] = None
    headers: Optional[Dict[str, str]] = None
    cookies: Optional[List[Cookie]] = None
    javascript: Optional[bool] = None
    mobile: Optional[bool] = None
    screenshot: Optional[Union[bool, ScreenshotOptions]] = None
    proxy: Optional[str] = None
    cache: Optional[Union[bool, CacheOptions]] = None
    retry: Optional[RetryOptions] = None

class OpenGraph(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    type: Optional[str] = None
    url: Optional[str] = None

class TwitterCard(BaseModel):
    card: Optional[str] = None
    site: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None

class PageMetadata(BaseModel):
    url: str
    title: Optional[str] = None
    description: Optional[str] = None
    image: Optional[str] = None
    author: Optional[str] = None
    published: Optional[datetime] = None
    keywords: Optional[List[str]] = None
    favicon: Optional[str] = None
    site_name: Optional[str] = Field(None, alias="siteName")
    locale: Optional[str] = None
    type: Optional[str] = None
    open_graph: Optional[OpenGraph] = Field(None, alias="openGraph")
    twitter: Optional[TwitterCard] = None
    json_ld: Optional[List[Any]] = Field(None, alias="jsonLd")

class PageResult(BaseModel):
    url: str
    content: str
    metadata: PageMetadata
    links: Optional[List[str]] = None
    images: Optional[List[str]] = None
    screenshot: Optional[bytes] = None
    provider: str
    cached: Optional[bool] = None
    duration: Optional[float] = None

class MetadataOptions(BaseModel):
    fields: Optional[List[Literal['title', 'description', 'image', 'author', 'published', 'keywords', 'favicon']]] = None
    timeout: Optional[int] = None
    concurrency: Optional[int] = None
    cache: Optional[bool] = None
    # on_progress omitted

class MetadataResult(BaseModel):
    success: bool
    data: Optional[PageMetadata] = None
    error: Optional[str] = None
    cached: Optional[bool] = None
    duration: Optional[float] = None
    provider: Optional[str] = None

class ProviderCapabilities(BaseModel):
    formats: List[Literal['html', 'markdown', 'text', 'json']]
    javascript: bool
    screenshots: bool
    cookies: bool
    headers: bool
    selectors: Optional[bool] = None
    proxy: Optional[bool] = None

@runtime_checkable
class WebProvider(Protocol):
    name: str
    capabilities: ProviderCapabilities

    async def get_page(self, url: str, options: GetPageOptions) -> PageResult:
        ...

    async def is_available(self) -> bool:
        ...

# ===== Image Types =====

class ImageConfig(BaseModel):
    default_provider: Optional[str] = Field(None, alias="defaultProvider")
    providers: Optional[Dict[str, ProviderConfig]] = None
    cache: Optional[CacheConfig] = None

class ImageFilters(BaseModel):
    min_width: Optional[int] = Field(None, alias="minWidth")
    min_height: Optional[int] = Field(None, alias="minHeight")
    max_width: Optional[int] = Field(None, alias="maxWidth")
    max_height: Optional[int] = Field(None, alias="maxHeight")
    safe_search: Optional[bool] = Field(None, alias="safeSearch")
    license: Optional[Literal['free', 'premium', 'editorial']] = None

class ImageSearchOptions(BaseModel):
    provider: Optional[str] = None
    page: Optional[int] = None
    per_page: Optional[int] = Field(None, alias="perPage")
    orientation: Optional[Literal['landscape', 'portrait', 'square']] = None
    color: Optional[str] = None
    order_by: Optional[Literal['relevant', 'latest', 'popular']] = Field(None, alias="orderBy")
    filters: Optional[ImageFilters] = None
    cache: Optional[bool] = None

class ImageAuthor(BaseModel):
    name: str
    url: Optional[str] = None

class ImageSource(BaseModel):
    provider: str
    url: str

class ImageDownloads(BaseModel):
    small: Optional[str] = None
    medium: Optional[str] = None
    large: Optional[str] = None
    original: Optional[str] = None

class ImageResult(BaseModel):
    id: str
    url: str
    thumbnail: str
    width: int
    height: int
    description: Optional[str] = None
    alt: Optional[str] = None
    author: Optional[ImageAuthor] = None
    source: ImageSource
    license: Optional[str] = None
    tags: Optional[List[str]] = None
    downloads: Optional[ImageDownloads] = None

class ImageSearchResult(BaseModel):
    query: str
    total: int
    page: int
    per_page: int = Field(alias="perPage")
    results: List[ImageResult]
    next_page: Optional[int] = Field(None, alias="nextPage")
    provider: str

class ImageCrop(BaseModel):
    x: int
    y: int
    width: int
    height: int

class Watermark(BaseModel):
    text: Optional[str] = None
    image: Optional[str] = None
    position: Optional[Literal['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']] = None
    opacity: Optional[float] = None

class ImageDownloadOptions(BaseModel):
    destination: Optional[str] = None
    filename: Optional[str] = None
    size: Optional[Literal['small', 'medium', 'large', 'original']] = None
    format: Optional[Literal['jpeg', 'png', 'webp']] = None
    quality: Optional[int] = None
    max_width: Optional[int] = Field(None, alias="maxWidth")
    max_height: Optional[int] = Field(None, alias="maxHeight")
    crop: Optional[ImageCrop] = None
    watermark: Optional[Watermark] = None
    metadata: Optional[bool] = None
    overwrite: Optional[bool] = None
    # on_progress omitted

class ImageMetadata(BaseModel):
    format: str
    width: int
    height: int
    size: int
    color_space: Optional[str] = Field(None, alias="colorSpace")
    has_alpha: Optional[bool] = Field(None, alias="hasAlpha")
    exif: Optional[Dict[str, Any]] = None

class DownloadResult(BaseModel):
    success: bool
    path: Optional[str] = None
    size: Optional[int] = None
    format: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    metadata: Optional[ImageMetadata] = None
    error: Optional[str] = None
    duration: Optional[float] = None

@runtime_checkable
class ImageProvider(Protocol):
    name: str
    
    async def search(self, query: str, options: ImageSearchOptions) -> ImageSearchResult:
        ...
    
    async def download(self, url: str, options: ImageDownloadOptions) -> DownloadResult:
        ...
    
    async def is_available(self) -> bool:
        ...

# ===== Geo Types =====

class GeoConfig(BaseModel):
    default_provider: Optional[str] = Field(None, alias="defaultProvider")
    providers: Optional[Dict[str, ProviderConfig]] = None
    cache: Optional[CacheConfig] = None

class GeoLocation(BaseModel):
    lat: float
    lng: float

class GeoAddress(BaseModel):
    formatted: str
    street: Optional[str] = None
    street_number: Optional[str] = Field(None, alias="streetNumber")
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    postal_code: Optional[str] = Field(None, alias="postalCode")
    country_code: Optional[str] = Field(None, alias="countryCode")
    neighborhood: Optional[str] = None
    district: Optional[str] = None
    region: Optional[str] = None

class ReverseGeocodeResult(BaseModel):
    location: GeoLocation
    address: GeoAddress
    accuracy: Optional[float] = None
    place_id: Optional[str] = Field(None, alias="placeId")
    provider: str
    cached: Optional[bool] = None

class GeoBounds(BaseModel):
    sw: GeoLocation
    ne: GeoLocation

class GeoComponents(BaseModel):
    country: Optional[str] = None
    postal_code: Optional[str] = Field(None, alias="postalCode")
    locality: Optional[str] = None

class GeocodeOptions(BaseModel):
    provider: Optional[str] = None
    limit: Optional[int] = None
    bounds: Optional[GeoBounds] = None
    components: Optional[GeoComponents] = None
    cache: Optional[bool] = None

class GeoSearchOptions(BaseModel):
    provider: Optional[str] = None
    query: str
    center: Optional[GeoLocation] = None
    radius: Optional[float] = None
    types: Optional[List[Literal['address', 'city', 'country', 'poi', 'postcode']]] = None
    language: Optional[str] = None
    limit: Optional[int] = None
    bounds: Optional[GeoBounds] = None
    components: Optional[GeoComponents] = None
    cache: Optional[bool] = None

class OpeningPeriod(BaseModel):
    day: int
    time: str

class OpeningHoursPeriod(BaseModel):
    open: OpeningPeriod
    close: OpeningPeriod

class OpeningHours(BaseModel):
    open: bool
    periods: Optional[List[OpeningHoursPeriod]] = None

class GeoPlace(BaseModel):
    id: str
    name: str
    location: GeoLocation
    address: GeoAddress
    types: Optional[List[str]] = None
    distance: Optional[float] = None
    rating: Optional[float] = None
    reviews: Optional[int] = None
    photos: Optional[List[str]] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    opening_hours: Optional[OpeningHours] = Field(None, alias="openingHours")
    provider: str

@runtime_checkable
class GeoProvider(Protocol):
    name: str

    async def reverse_geocode(self, location: GeoLocation) -> ReverseGeocodeResult:
        ...

    async def geocode(self, address: str, options: GeocodeOptions) -> List[ReverseGeocodeResult]:
        ...
        
    async def search(self, options: GeoSearchOptions) -> List[GeoPlace]:
        ...
        
    async def get_place_details(self, place_id: str, fields: Optional[List[str]] = None) -> GeoPlace:
        ...

    async def is_available(self) -> bool:
        ...

# ===== Main Config =====

class BrowseFnConfig(BaseModel):
    web: Optional[WebConfig] = None
    images: Optional[ImageConfig] = None
    geo: Optional[GeoConfig] = None
    cache: Optional[CacheConfig] = None
    rate_limit: Optional[Dict[str, Union[RateLimitConfig, Dict[str, RateLimitConfig]]]] = Field(None, alias="rateLimit")
    retry: Optional[RetryConfig] = None
