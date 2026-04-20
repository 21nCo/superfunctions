# TV-PKG-001

- **Description**: TypeScript and Python package metadata, versioning, and public docs are aligned.
- **Input**:
```json
{
  "typescriptPackage": {
    "name": "browsefn",
    "license": "Apache-2.0",
    "repositoryDirectory": "browsefn/typescript",
    "version": "0.1.0"
  },
  "pythonPackage": {
    "name": "browsefn",
    "license": "Apache-2.0",
    "version": "0.1.0",
    "__version__": "0.1.0"
  },
  "docs": {
    "mentionsTsSdk": false,
    "pythonStatus": "Alpha"
  }
}
```
- **Expected output**:
```json
{
  "ok": true
}
```
- **Negative variant(s)**:
```json
{
  "typescriptPackage": {
    "name": "@browsefn/core",
    "license": "MIT",
    "repositoryDirectory": "browsefn/ts-sdk",
    "version": "0.0.1"
  },
  "pythonPackage": {
    "name": "browsefn",
    "license": "Apache-2.0",
    "version": "0.0.1",
    "__version__": "0.1.0"
  },
  "docs": {
    "mentionsTsSdk": true,
    "pythonStatus": "coming soon"
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "BrowseFn package metadata and docs are not internally consistent."
  }
}
```

# TV-API-001

- **Description**: Canonical provider IDs, alias normalization, exports, and provider listing are stable.
- **Input**:
```json
{
  "requestedGeoProvider": "googleMaps",
  "registeredProviders": ["playwright", "cheerio", "firecrawl"],
  "pythonRegisteredProviders": ["beautifulsoup", "pexels", "nominatim"]
}
```
- **Expected output**:
```json
{
  "normalizedGeoProvider": "google-maps",
  "typescriptListProviders": ["cheerio", "firecrawl", "playwright"],
  "pythonWebProviderAlias": "bs4"
}
```
- **Negative variant(s)**:
```json
{
  "requestedGeoProvider": "googlemaps-v2"
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "UNSUPPORTED_PROVIDER",
    "message": "Unknown provider: googlemaps-v2"
  }
}
```

# TV-WEB-001

- **Description**: `getPage()` performs capability-aware provider selection and returns canonical page data.
- **Input**:
```json
{
  "url": "https://example.com/article",
  "options": {
    "provider": "puppeteer",
    "format": "markdown",
    "javascript": true,
    "screenshot": { "fullPage": true, "format": "png" },
    "includeLinks": true,
    "includeImages": true
  }
}
```
- **Expected output**:
```json
{
  "url": "https://example.com/article",
  "provider": "puppeteer",
  "contentFormat": "markdown",
  "hasLinks": true,
  "hasImages": true,
  "hasScreenshot": true
}
```
- **Negative variant(s)**:
```json
{
  "url": "https://example.com/article",
  "options": {
    "provider": "cheerio",
    "javascript": true,
    "screenshot": true
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "UNSUPPORTED_PROVIDER_CAPABILITY",
    "message": "Provider cheerio cannot satisfy javascript or screenshot requirements."
  }
}
```

# TV-WEB-002

- **Description**: `getMultipleMetadata()` preserves input order, filters fields, and reports progress.
- **Input**:
```json
{
  "urls": [
    "https://example.com/a",
    "https://example.com/b"
  ],
  "options": {
    "fields": ["title", "description"],
    "concurrency": 2
  }
}
```
- **Expected output**:
```json
{
  "results": [
    { "success": true, "data": { "url": "https://example.com/a", "title": "A", "description": "Alpha" } },
    { "success": true, "data": { "url": "https://example.com/b", "title": "B", "description": "Beta" } }
  ],
  "progressCalls": [[1, 2], [2, 2]]
}
```
- **Negative variant(s)**:
```json
{
  "urls": ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
  "options": {
    "concurrency": 3,
    "maxBatchOverride": 2
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Metadata batch size exceeds the configured maximum."
  }
}
```

# TV-WEB-003

- **Description**: `scrape()` executes a browser-provider script and remains library-only.
- **Input**:
```json
{
  "url": "https://example.com/product",
  "options": {
    "provider": "playwright",
    "scriptResult": {
      "title": "Example Product",
      "price": "$10.00"
    }
  }
}
```
- **Expected output**:
```json
{
  "title": "Example Product",
  "price": "$10.00"
}
```
- **Negative variant(s)**:
```json
{
  "url": "https://example.com/product",
  "options": {
    "provider": "cheerio",
    "script": "custom"
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "UNSUPPORTED_PROVIDER_CAPABILITY",
    "message": "Provider cheerio cannot execute custom scrape scripts."
  }
}
```

# TV-IMG-001

- **Description**: Image search normalizes provider output and validates filters.
- **Input**:
```json
{
  "query": "mountain landscape",
  "options": {
    "provider": "unsplash",
    "perPage": 20,
    "orientation": "landscape",
    "filters": {
      "minWidth": 1920,
      "safeSearch": true
    }
  }
}
```
- **Expected output**:
```json
{
  "query": "mountain landscape",
  "provider": "unsplash",
  "page": 1,
  "perPage": 20,
  "resultProvider": "unsplash"
}
```
- **Negative variant(s)**:
```json
{
  "query": "mountain landscape",
  "options": {
    "provider": "unsplash",
    "perPage": 0
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "perPage must be between 1 and 100."
  }
}
```

# TV-IMG-002

- **Description**: Image downloads write real files, preserve order in batch mode, and enforce overwrite behavior.
- **Input**:
```json
{
  "single": {
    "url": "https://images.example.com/a.jpg",
    "options": {
      "destination": "tmp/downloads",
      "filename": "a.jpg",
      "overwrite": false,
      "metadata": true
    }
  },
  "batch": {
    "urls": [
      "https://images.example.com/a.jpg",
      "https://images.example.com/b.jpg"
    ],
    "options": {
      "destination": "tmp/downloads",
      "concurrency": 2
    }
  }
}
```
- **Expected output**:
```json
{
  "single": {
    "success": true,
    "path": "tmp/downloads/a.jpg",
    "metadata": { "format": "jpeg" }
  },
  "batch": [
    { "success": true, "path": "tmp/downloads/a.jpg" },
    { "success": true, "path": "tmp/downloads/b.jpg" }
  ],
  "progressCalls": [[1, 2], [2, 2]]
}
```
- **Negative variant(s)**:
```json
{
  "single": {
    "url": "https://images.example.com/a.jpg",
    "options": {
      "destination": "tmp/downloads",
      "filename": "a.jpg",
      "overwrite": false,
      "fileAlreadyExists": true
    }
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "DOWNLOAD_EXISTS",
    "message": "Destination file already exists and overwrite is disabled."
  }
}
```

# TV-GEO-001

- **Description**: Reverse geocoding normalizes provider aliases and validates coordinates.
- **Input**:
```json
{
  "location": { "lat": 40.7128, "lng": -74.0060 },
  "options": { "provider": "googleMaps" }
}
```
- **Expected output**:
```json
{
  "provider": "google-maps",
  "location": { "lat": 40.7128, "lng": -74.0060 },
  "address": { "formatted": "New York, NY, USA" }
}
```
- **Negative variant(s)**:
```json
{
  "location": { "lat": 120.0, "lng": -74.0060 },
  "options": { "provider": "nominatim" }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Latitude must be between -90 and 90."
  }
}
```

# TV-GEO-002

- **Description**: Geo search and place details normalize into `GeoPlace`.
- **Input**:
```json
{
  "search": {
    "query": "coffee shops",
    "center": { "lat": 40.7128, "lng": -74.0060 },
    "provider": "mapbox",
    "limit": 2
  },
  "details": {
    "placeId": "place-123",
    "provider": "mapbox",
    "fields": ["name", "address", "rating"]
  }
}
```
- **Expected output**:
```json
{
  "searchResults": [
    { "id": "place-123", "provider": "mapbox" },
    { "id": "place-456", "provider": "mapbox" }
  ],
  "details": {
    "id": "place-123",
    "provider": "mapbox",
    "rating": 4.5
  }
}
```
- **Negative variant(s)**:
```json
{
  "details": {
    "placeId": "place-123",
    "provider": "nominatim",
    "requiresFullDetails": true
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "UNSUPPORTED_PROVIDER_CAPABILITY",
    "message": "Provider nominatim does not support full place-details retrieval."
  }
}
```

# TV-CACHE-001

- **Description**: Cache config normalizes aliases and rejects unsupported backends.
- **Input**:
```json
{
  "cache": {
    "enabled": true,
    "ttl": 3600000,
    "storage": "memory",
    "maxSize": 1000
  }
}
```
- **Expected output**:
```json
{
  "normalizedCacheConfig": {
    "enabled": true,
    "ttl": 3600000,
    "storage": "memory",
    "maxSize": 1000
  }
}
```
- **Negative variant(s)**:
```json
{
  "cache": {
    "enabled": true,
    "storage": "redis"
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Unsupported cache storage: redis"
  }
}
```

# TV-RATE-001

- **Description**: Shared rate limiting enforces global and per-provider limits deterministically.
- **Input**:
```json
{
  "rateLimit": {
    "global": { "requests": 2, "window": 60000 },
    "perProvider": {
      "unsplash": { "requests": 1, "window": 60000 }
    }
  },
  "requests": [
    { "provider": "unsplash" },
    { "provider": "unsplash" }
  ]
}
```
- **Expected output**:
```json
{
  "results": [
    { "allowed": true, "provider": "unsplash" },
    {
      "allowed": false,
      "error": {
        "code": "RATE_LIMITED",
        "message": "Rate limit exceeded for provider unsplash."
      }
    }
  ]
}
```
- **Negative variant(s)**:
```json
{
  "sharedImportPresent": false
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "BrowseFn TypeScript rate limiting is not delegated to the shared middleware package."
  }
}
```

# TV-ERR-001

- **Description**: Retry and fallback produce structured errors and record the actual provider used.
- **Input**:
```json
{
  "fallbackChain": ["firecrawl", "cheerio"],
  "retry": {
    "enabled": true,
    "maxAttempts": 2,
    "delay": 100,
    "backoff": "linear",
    "retryOn": [504]
  },
  "upstreamSequence": [
    { "provider": "firecrawl", "status": 504 },
    { "provider": "cheerio", "status": 200 }
  ]
}
```
- **Expected output**:
```json
{
  "ok": true,
  "meta": {
    "provider": "cheerio",
    "fallbackFrom": "firecrawl"
  }
}
```
- **Negative variant(s)**:
```json
{
  "fallbackChain": ["firecrawl"],
  "retry": {
    "enabled": true,
    "maxAttempts": 2,
    "delay": 100,
    "backoff": "linear",
    "retryOn": [504]
  },
  "upstreamSequence": [
    { "provider": "firecrawl", "status": 504 },
    { "provider": "firecrawl", "status": 504 }
  ]
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "UPSTREAM_TIMEOUT",
    "message": "Provider firecrawl timed out after configured retries."
  }
}
```

# TV-OBS-001

- **Description**: Metrics, logs, and events are recorded for a successful cached response without leaking secrets.
- **Input**:
```json
{
  "request": {
    "provider": "unsplash",
    "url": "https://api.unsplash.com/search?client_id=SECRET"
  },
  "result": {
    "cached": true,
    "durationMs": 42
  }
}
```
- **Expected output**:
```json
{
  "metrics": {
    "totalRequests": 1,
    "cacheHitRate": 100
  },
  "events": ["request", "cache.hit", "response"],
  "logsContainSecret": false
}
```
- **Negative variant(s)**:
```json
{
  "logRecord": {
    "url": "https://api.unsplash.com/search?client_id=SECRET",
    "headers": {
      "Authorization": "Bearer SECRET"
    }
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Sensitive request data was written to logs or metrics."
  }
}
```

# TV-HTTP-001

- **Description**: Router success and failure responses use canonical envelopes.
- **Input**:
```json
{
  "request": {
    "method": "POST",
    "path": "/web/page",
    "body": {
      "url": "https://example.com",
      "options": { "format": "text" }
    }
  }
}
```
- **Expected output**:
```json
{
  "status": 200,
  "body": {
    "ok": true,
    "data": {
      "url": "https://example.com",
      "provider": "cheerio"
    },
    "meta": {
      "requestId": "opaque-id",
      "provider": "cheerio"
    }
  }
}
```
- **Negative variant(s)**:
```json
{
  "request": {
    "method": "POST",
    "path": "/web/page",
    "body": {}
  }
}
```
Expected error:
```json
{
  "status": 400,
  "body": {
    "ok": false,
    "error": {
      "code": "INVALID_ARGUMENT",
      "message": "Missing required field: url"
    }
  }
}
```

# TV-PY-001

- **Description**: Python router input is converted into typed models before service invocation and returns canonical JSON.
- **Input**:
```json
{
  "request": {
    "method": "GET",
    "path": "/geo/geocode",
    "query": {
      "address": "1600 Amphitheatre Parkway",
      "provider": "googleMaps",
      "limit": "1"
    }
  }
}
```
- **Expected output**:
```json
{
  "status": 200,
  "body": {
    "ok": true,
    "data": {
      "results": [
        {
          "provider": "google-maps"
        }
      ]
    }
  }
}
```
- **Negative variant(s)**:
```json
{
  "request": {
    "method": "GET",
    "path": "/geo/reverse",
    "query": {
      "lat": "north",
      "lng": "-74.0060"
    }
  }
}
```
Expected error:
```json
{
  "status": 400,
  "body": {
    "ok": false,
    "error": {
      "code": "INVALID_ARGUMENT",
      "message": "lat must be a number."
    }
  }
}
```

# TV-SEC-001

- **Description**: Security controls block unsafe targets by default and allow safe public hosts.
- **Input**:
```json
{
  "allowedRequest": {
    "url": "https://example.com/docs"
  },
  "blockedRequest": {
    "url": "http://127.0.0.1/admin"
  }
}
```
- **Expected output**:
```json
{
  "allowedRequest": {
    "ok": true
  },
  "blockedRequest": {
    "ok": false,
    "error": {
      "code": "SECURITY_POLICY_BLOCKED",
      "message": "Target host is not allowed by the active security policy."
    }
  }
}
```
- **Negative variant(s)**:
```json
{
  "download": {
    "destination": "../secrets",
    "filename": "../../token.txt"
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "SECURITY_POLICY_BLOCKED",
    "message": "Download path escapes the destination root."
  }
}
```

# TV-DOC-001

- **Description**: BrowseFn docs are accurate, portable, and do not advertise stale or unspecified surfaces.
- **Input**:
```json
{
  "docs": {
    "containsAbsolutePaths": false,
    "containsTsSdk": false,
    "containsDashboardClaims": false,
    "containsCliClaims": false,
    "pythonStatus": "Alpha"
  }
}
```
- **Expected output**:
```json
{
  "ok": true
}
```
- **Negative variant(s)**:
```json
{
  "docs": {
    "containsAbsolutePaths": true,
    "containsTsSdk": true,
    "pythonStatus": "coming soon and fully implemented"
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "BrowseFn docs contain stale or machine-specific claims."
  }
}
```

# TV-SHARED-001

- **Description**: BrowseFn reuses shared packages and stays under the duplication threshold.
- **Input**:
```json
{
  "typescriptRouterImport": "@superfunctions/http",
  "typescriptRateLimitImport": "@superfunctions/middleware/rate-limit",
  "pythonRouterImport": "superfunctions.http",
  "jscpdPercent": 4.8
}
```
- **Expected output**:
```json
{
  "ok": true
}
```
- **Negative variant(s)**:
```json
{
  "typescriptRateLimitImport": "./core/rate-limiter-local-only",
  "jscpdPercent": 8.25
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "BrowseFn still owns duplicated infrastructure instead of reusing shared packages."
  }
}
```

# TV-QA-001

- **Description**: The full BrowseFn local verification gate passes from the repo root.
- **Input**:
```json
{
  "commands": [
    "npm --prefix browsefn/typescript run build",
    "npm --prefix browsefn/typescript run typecheck",
    "npm --prefix browsefn/typescript run test -- --run",
    "python3 -m compileall browsefn/python/browsefn browsefn/python/tests",
    "python3 -m pytest browsefn/python/tests -q",
    "npx jscpd browsefn/typescript/src browsefn/python/browsefn --min-lines 5 --min-tokens 50 --reporters console"
  ]
}
```
- **Expected output**:
```json
{
  "ok": true,
  "failedCommands": []
}
```
- **Negative variant(s)**:
```json
{
  "commands": [
    "npm --prefix browsefn/typescript run typecheck",
    "python3 -m compileall browsefn/python/browsefn browsefn/python/tests"
  ],
  "failures": [
    "browsefn/typescript/src/core/cache-manager.ts: error TS2339",
    "browsefn/python/tests/test_middleware.py: IndentationError"
  ]
}
```
Expected error:
```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "BrowseFn verification gate failed."
  }
}
```
