# TV-SF-001
- Description: Standalone in-memory client initializes resources, indexes documents, and returns matching IDs.
- Input:
```json
{
  "adapter": "memory",
  "initialize": {
    "resources": [
      { "name": "tasks", "searchFields": ["title", "body"] }
    ]
  },
  "index": {
    "resource": "tasks",
    "documents": [
      { "id": "t1", "fields": { "title": "Hybrid search", "body": "Swift local index" } },
      { "id": "t2", "fields": { "title": "Groceries", "body": "Milk and bread" } }
    ]
  },
  "search": {
    "resource": "tasks",
    "query": "hybrid"
  }
}
```
- Expected output:
```json
{
  "ids": ["t1"]
}
```
- Negative variant(s):
```json
{
  "search": {
    "resource": "",
    "query": "hybrid"
  },
  "error": {
    "code": "DFQL_INVALID",
    "message": "resource must be a non-empty string",
    "details": { "path": "resource" }
  }
}
```

# TV-SF-002
- Description: Defaults for prefix, fuzzy, and fieldBoosts are applied by the client and can be overridden per call.
- Input:
```json
{
  "defaults": {
    "prefix": true,
    "fuzzy": "enabled",
    "fieldBoosts": { "title": 3.0 }
  },
  "search": {
    "resource": "tasks",
    "query": "hyb"
  },
  "searchOverride": {
    "resource": "tasks",
    "query": "hyb",
    "prefix": false,
    "fieldBoosts": { "body": 5.0 }
  }
}
```
- Expected output:
```json
{
  "delegatedSearch": {
    "resource": "tasks",
    "query": "hyb",
    "prefix": true,
    "fuzzy": "enabled",
    "fieldBoosts": { "title": 3.0 }
  },
  "delegatedSearchOverride": {
    "resource": "tasks",
    "query": "hyb",
    "prefix": false,
    "fuzzy": "enabled",
    "fieldBoosts": { "body": 5.0 }
  }
}
```
- Negative variant(s):
```json
{
  "search": {
    "resource": "tasks",
    "query": "a",
    "fuzzy": { "distance": 4 }
  },
  "error": {
    "code": "DFQL_INVALID",
    "message": "fuzzy distance must be between 1 and 3",
    "details": { "path": "fuzzy" }
  }
}
```

# TV-SF-003
- Description: Native `searchAll` results are deterministically sorted by score desc, resource asc, and id asc.
- Input:
```json
{
  "adapterSearchAllResults": [
    { "resource": "beta", "id": "b1", "score": 5.0 },
    { "resource": "alpha", "id": "a2", "score": 5.0 },
    { "resource": "alpha", "id": "a1", "score": 5.0 },
    { "resource": "alpha", "id": "a3", "score": 10.0 }
  ],
  "searchAll": {
    "query": "incident",
    "resources": ["alpha", "beta"]
  }
}
```
- Expected output:
```json
{
  "results": [
    { "resource": "alpha", "id": "a3", "score": 10.0 },
    { "resource": "alpha", "id": "a1", "score": 5.0 },
    { "resource": "alpha", "id": "a2", "score": 5.0 },
    { "resource": "beta", "id": "b1", "score": 5.0 }
  ]
}
```
- Negative variant(s):
```json
{
  "searchAll": {
    "query": "",
    "resources": ["alpha"]
  },
  "error": {
    "code": "DFQL_INVALID",
    "message": "Search query must not be empty",
    "details": { "path": "query" }
  }
}
```

# TV-SF-004
- Description: Client fallback `searchAll` requires explicit resources and merges per-resource results deterministically when the adapter lacks native `searchAll`.
- Input:
```json
{
  "adapter": "memory-without-searchAll",
  "perResourceResults": {
    "alpha": ["a1", "a2"],
    "beta": ["b1"]
  },
  "searchAll": {
    "query": "hello",
    "resources": ["alpha", "beta"],
    "limitPerResource": 10
  }
}
```
- Expected output:
```json
{
  "results": [
    { "resource": "alpha", "id": "a1", "score": 2.0 },
    { "resource": "alpha", "id": "a2", "score": 1.0 },
    { "resource": "beta", "id": "b1", "score": 1.0 }
  ]
}
```
- Negative variant(s):
```json
{
  "searchAll": {
    "query": "hello"
  },
  "error": {
    "code": "DFQL_INVALID",
    "message": "resources are required when adapter.searchAll is unavailable",
    "details": { "path": "resources" }
  }
}
```

# TV-SF-005
- Description: Validation limits reject empty queries, invalid limits, and oversized batches with canonical codes.
- Input:
```json
{
  "invalidSearch": {
    "resource": "tasks",
    "query": "   "
  },
  "invalidLimit": {
    "resource": "tasks",
    "query": "x",
    "limit": 10001
  },
  "invalidBatch": {
    "resource": "tasks",
    "documentsCount": 10001
  }
}
```
- Expected output:
```json
{
  "errors": [
    {
      "code": "DFQL_INVALID",
      "message": "Search query must not be empty",
      "details": { "path": "query" }
    },
    {
      "code": "LIMIT_EXCEEDED",
      "message": "limit exceeds maximum of 10000",
      "details": { "path": "limit" }
    },
    {
      "code": "LIMIT_EXCEEDED",
      "message": "documents exceeds maximum batch size of 10000",
      "details": { "path": "documents" }
    }
  ]
}
```
- Negative variant(s):
```json
{
  "validSearch": {
    "resource": "tasks",
    "query": "x",
    "limit": 10000
  },
  "expected": {
    "delegated": true
  }
}
```

# TV-SF-006
- Description: SQLite adapter persists and reopens a caller-supplied index under a deterministic on-disk path.
- Input:
```json
{
  "sqlite": {
    "rootURL": "tmp/search-root",
    "indexKey": "project-docs"
  },
  "initialize": {
    "resources": [
      { "name": "docs", "searchFields": ["title", "body"] }
    ]
  },
  "index": {
    "resource": "docs",
    "documents": [
      { "id": "d1", "fields": { "title": "Getting started", "body": "Swift search runtime" } }
    ]
  },
  "reopenSearch": {
    "resource": "docs",
    "query": "getting"
  }
}
```
- Expected output:
```json
{
  "path": "tmp/search-root/project-docs-<hash16>/searchfn.sqlite",
  "manifest": {
    "format": "searchfn-swift/v1",
    "indexKey": "project-docs"
  },
  "idsAfterReopen": ["d1"]
}
```
- Negative variant(s):
```json
{
  "tamperedManifest": {
    "sqliteSchemaVersion": 999
  },
  "error": {
    "code": "SEARCH_INDEX_FORMAT_MISMATCH",
    "message": "Persisted SearchFn index format does not match runtime expectations"
  }
}
```

# TV-SF-007
- Description: Remove and clear semantics are resource-scoped and idempotent.
- Input:
```json
{
  "initialDocuments": [
    { "resource": "tasks", "id": "t1", "fields": { "title": "alpha" } },
    { "resource": "tasks", "id": "t2", "fields": { "title": "beta" } },
    { "resource": "notes", "id": "n1", "fields": { "title": "alpha" } }
  ],
  "remove": {
    "resource": "tasks",
    "ids": ["t1", "t1"]
  },
  "clear": {
    "resource": "notes"
  }
}
```
- Expected output:
```json
{
  "tasksAfterRemoveSearchAlpha": [],
  "tasksAfterRemoveSearchBeta": ["t2"],
  "notesAfterClearSearchAlpha": []
}
```
- Negative variant(s):
```json
{
  "remove": {
    "resource": "",
    "ids": ["t1"]
  },
  "error": {
    "code": "DFQL_INVALID",
    "message": "resource must be a non-empty string",
    "details": { "path": "resource" }
  }
}
```

# TV-SF-008
- Description: Disposed or corrupted persistent adapters fail deterministically.
- Input:
```json
{
  "adapterState": "disposed",
  "operation": {
    "search": {
      "resource": "tasks",
      "query": "x"
    }
  }
}
```
- Expected output:
```json
{
  "error": {
    "code": "SEARCH_ADAPTER_DISPOSED",
    "message": "Search adapter has been disposed"
  }
}
```
- Negative variant(s):
```json
{
  "operation": {
    "search": {
      "resource": "tasks",
      "query": "x"
    }
  },
  "expected": {
    "error": null
  }
}
```

# TV-SF-009
- Description: High-level convenience APIs wrap the underlying client rather than inventing different semantics.
- Input:
```json
{
  "api": "InMemorySearchFn",
  "workflow": [
    "initialize tasks(title)",
    "index t1(title=hello)",
    "search hello"
  ]
}
```
- Expected output:
```json
{
  "ids": ["t1"],
  "adapterInfo": {
    "name": "memory"
  }
}
```
- Negative variant(s):
```json
{
  "api": "SearchFn",
  "sqlite": {
    "rootURL": "",
    "indexKey": "demo"
  },
  "error": {
    "code": "DFQL_INVALID",
    "message": "rootURL must be a file URL"
  }
}
```

# TV-SF-010
- Description: Engine semantics preserve exact-match preference, prefix support, fuzzy support, and deterministic field boosts.
- Input:
```json
{
  "documents": [
    { "id": "a", "fields": { "title": "report", "body": "weekly summary" } },
    { "id": "b", "fields": { "title": "reporting", "body": "finance" } },
    { "id": "c", "fields": { "title": "repotr", "body": "typo sample" } }
  ],
  "queries": [
    { "resource": "docs", "query": "report", "prefix": true, "fuzzy": "enabled", "fieldBoosts": { "title": 3.0 } }
  ]
}
```
- Expected output:
```json
{
  "orderedIds": ["a", "b", "c"]
}
```
- Negative variant(s):
```json
{
  "query": {
    "resource": "docs",
    "query": "report",
    "fuzzy": { "distance": 0 }
  },
  "error": {
    "code": "DFQL_INVALID",
    "message": "fuzzy distance must be between 1 and 3",
    "details": { "path": "fuzzy" }
  }
}
```
