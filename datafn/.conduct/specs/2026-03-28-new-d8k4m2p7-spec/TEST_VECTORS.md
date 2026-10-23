# TV-DFS-001
- Description: Browser-owned mode remains unchanged and continues to use a JavaScript search provider with IndexedDB persistence.
- Input:
```json
{
  "topology": "browser-owned",
  "storage": "IndexedDbStorageAdapter",
  "searchProvider": "createSearchProvider(new IndexedDbAdapter(...))",
  "schema": {
    "resources": [
      {
        "name": "todos",
        "indices": { "search": ["text"] }
      }
    ]
  },
  "query": {
    "resource": "todos",
    "search": { "query": "milk", "topK": 10 }
  }
}
```
- Expected output:
```json
{
  "searchOwner": "javascript",
  "indexedDbSearchUsed": true,
  "nativeBridgeUsed": false
}
```
- Negative variant(s):
```json
{
  "query": {
    "resource": "todos",
    "search": { "query": "milk", "topK": 10 }
  },
  "withoutSearchProvider": true,
  "error": {
    "code": "DFQL_UNSUPPORTED"
  }
}
```

# TV-DFS-002
- Description: Native-backed provider initialization derives search fields from schema indices and bridges them to Swift.
- Input:
```json
{
  "topology": "native-backed-datafn-server",
  "schema": {
    "resources": [
      { "name": "todos", "indices": { "search": ["text"] } },
      { "name": "categories", "indices": { "search": ["name"] } },
      { "name": "audit", "indices": { "search": [] } }
    ]
  },
  "bridgeRequest": {
    "protocol": "datafn-bridge/v1",
    "id": "req-1",
    "method": "search.initialize",
    "payload": {
      "resources": [
        { "name": "todos", "searchFields": ["text"] },
        { "name": "categories", "searchFields": ["name"] }
      ]
    }
  }
}
```
- Expected output:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-1",
  "ok": true,
  "result": { "initialized": true }
}
```
- Negative variant(s):
```json
{
  "bridgeRequest": {
    "protocol": "datafn-bridge/v1",
    "id": "req-2",
    "method": "search.initialize",
    "payload": {
      "resources": [
        { "name": "todos", "searchFields": ["text"] },
        { "name": "todos", "searchFields": ["text"] }
      ]
    }
  },
  "error": {
    "code": "DFQL_INVALID",
    "details": { "path": "resources" }
  }
}
```

# TV-DFS-003
- Description: Native-backed search requests route over the bridge and fail fast when the bridge is unavailable.
- Input:
```json
{
  "topology": "native-backed-datafn-server",
  "provider": "createNativeBackedSearchProvider(bus)",
  "search": {
    "resource": "todos",
    "query": "milk",
    "limit": 10
  }
}
```
- Expected output:
```json
{
  "bridgeMethod": "search.search",
  "indexedDbSearchUsed": false,
  "result": { "ids": ["td-1"] }
}
```
- Negative variant(s):
```json
{
  "bridgeUnavailable": true,
  "error": {
    "code": "NATIVE_BRIDGE_UNAVAILABLE"
  }
}
```

# TV-DFS-004
- Description: A WebView-local mutation updates the native search index through Swift-owned lifecycle, and JavaScript skips redundant index maintenance when the provider is native-backed.
- Input:
```json
{
  "topology": "native-backed-datafn-server",
  "mutation": {
    "resource": "todos",
    "operation": "insert",
    "record": { "id": "td-2", "text": "buy milk" }
  },
  "searchAfterMutation": {
    "resource": "todos",
    "query": "milk"
  }
}
```
- Expected output:
```json
{
  "nativeRuntimeIndexed": true,
  "jsUpdateIndicesInvocations": 0,
  "searchIds": ["td-2"]
}
```
- Negative variant(s):
```json
{
  "mutation": {
    "resource": "todos",
    "operation": "insert",
    "record": { "id": "td-3", "text": 42 }
  },
  "error": {
    "code": "DFQL_INVALID",
    "details": { "path": "record.text" }
  }
}
```

# TV-DFS-005
- Description: DataFn-server clone/pull writes update the native search backend in embedded mode.
- Input:
```json
{
  "topology": "native-backed-datafn-server",
  "syncEvents": [
    {
      "phase": "clone",
      "resource": "todos",
      "records": [
        { "id": "td-10", "text": "incident report" }
      ]
    }
  ],
  "searchAfterSync": {
    "resource": "todos",
    "query": "incident"
  }
}
```
- Expected output:
```json
{
  "nativeRuntimeIndexed": true,
  "searchIds": ["td-10"]
}
```
- Negative variant(s):
```json
{
  "searchConfiguration": null,
  "searchAfterSync": {
    "resource": "todos",
    "query": "incident"
  },
  "error": {
    "code": "NATIVE_SEARCH_UNAVAILABLE"
  }
}
```

# TV-DFS-006
- Description: CloudKit-backed mode updates the native search backend from Core Data merges while keeping the index local-only.
- Input:
```json
{
  "topology": "native-backed-icloud",
  "cloudKitImportedRecords": [
    { "resource": "todos", "id": "td-20", "text": "vacation plan" }
  ],
  "searchAfterImport": {
    "resource": "todos",
    "query": "vacation"
  }
}
```
- Expected output:
```json
{
  "datafnRemoteCalls": 0,
  "cloudKitSyncedIndexFiles": false,
  "searchIds": ["td-20"]
}
```
- Negative variant(s):
```json
{
  "cloudKitMode": true,
  "searchIndexReplicatedViaCloudKit": true,
  "error": {
    "code": "INTERNAL",
    "message": "Search index files must remain local-only in icloud mode"
  }
}
```

# TV-DFS-007
- Description: Search config digest mismatch clears and rebuilds the native search backend before ready.
- Input:
```json
{
  "storedMetadata": {
    "searchSchemaHash": "old-hash",
    "searchConfigDigest": "old-digest",
    "searchStatus": "ready"
  },
  "runtimeMetadata": {
    "searchSchemaHash": "new-hash",
    "searchConfigDigest": "new-digest"
  },
  "coreDataRecords": [
    { "resource": "todos", "id": "td-30", "text": "new schema task" }
  ]
}
```
- Expected output:
```json
{
  "searchStatusTransitions": ["rebuilding", "ready"],
  "indexCleared": true,
  "reindexedRecords": 1,
  "searchIds": ["td-30"]
}
```
- Negative variant(s):
```json
{
  "rebuildFailure": true,
  "failIfUnavailable": true,
  "error": {
    "code": "SEARCH_INDEX_REBUILD_FAILED"
  }
}
```

# TV-DFS-008
- Description: Missing bridge or failed rebuild surfaces deterministic native-search error codes.
- Input:
```json
{
  "topology": "native-backed-datafn-server",
  "search": {
    "resource": "todos",
    "query": "milk"
  }
}
```
- Expected output:
```json
{
  "error": {
    "code": "NATIVE_BRIDGE_UNAVAILABLE"
  }
}
```
- Negative variant(s):
```json
{
  "bridgeAvailable": true,
  "backendRebuilding": true,
  "error": {
    "code": "NATIVE_SEARCH_UNAVAILABLE"
  }
}
```

# TV-DFS-009
- Description: Invalid search requests and unsupported search configurations fail predictably.
- Input:
```json
{
  "search": {
    "resource": "todos",
    "query": "",
    "limit": 0
  }
}
```
- Expected output:
```json
{
  "error": {
    "code": "DFQL_INVALID",
    "details": { "path": "query" }
  }
}
```
- Negative variant(s):
```json
{
  "searchEnabledResources": [],
  "search": {
    "resource": "todos",
    "query": "milk"
  },
  "error": {
    "code": "DFQL_UNSUPPORTED"
  }
}
```

# TV-DFS-010
- Description: Direct Swift runtime search and bridge-based WebView search share one backend and return the same deterministic ordering.
- Input:
```json
{
  "records": [
    { "resource": "todos", "id": "td-40", "text": "incident report" },
    { "resource": "notes", "id": "nt-40", "name": "incident plan" }
  ],
  "bridgeSearchAll": {
    "query": "incident",
    "resources": ["notes", "todos"]
  },
  "swiftSearchAll": {
    "query": "incident",
    "resources": ["notes", "todos"]
  }
}
```
- Expected output:
```json
{
  "bridgeResults": [
    { "resource": "notes", "id": "nt-40" },
    { "resource": "todos", "id": "td-40" }
  ],
  "swiftResults": [
    { "resource": "notes", "id": "nt-40" },
    { "resource": "todos", "id": "td-40" }
  ]
}
```
- Negative variant(s):
```json
{
  "swiftRuntimeWithoutSearchBackend": true,
  "error": {
    "code": "NATIVE_SEARCH_UNAVAILABLE"
  }
}
```
