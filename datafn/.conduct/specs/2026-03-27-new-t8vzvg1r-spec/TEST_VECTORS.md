# TV-PKG-001
- Description: Package layout matches the required monorepo shape.
- Input:
```json
{
  "repoChecks": [
    "datafn/swift/Package.swift",
    "datafn/swift/Sources/DatafnAppleRuntime/DatafnAppleRuntime.swift",
    "datafn/swift/Sources/DatafnWebViewBridgeHost/DatafnWKWebViewBridgeHost.swift",
    "datafn/swift-bridge/package.json"
  ]
}
```
- Expected output:
```json
{
  "ok": true,
  "missing": []
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Required package artifact missing",
    "details": { "path": "datafn/swift/Package.swift" }
  }
}
```

# TV-API-001
- Description: Browser-owned mode remains valid.
- Input:
```json
{
  "storage": "indexeddb",
  "sync": {
    "owner": "javascript",
    "mode": "sync",
    "offlinability": true,
    "remote": "https://api.example.com/datafn"
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "syncOwner": "javascript",
    "storageBackend": "indexeddb"
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "remote or remoteAdapter is required in sync mode",
    "details": { "path": "sync" }
  }
}
```

# TV-API-002
- Description: Native-backed DataFn-server mode validates successfully.
- Input:
```json
{
  "storage": "native-backed",
  "sync": {
    "owner": "native",
    "mode": "sync",
    "offlinability": true,
    "remoteAdapter": "native-backed-remote-adapter",
    "native": {
      "syncController": "native-sync-controller",
      "remoteMode": "datafn-server",
      "expectedSchemaHash": "abc123",
      "failIfUnavailable": true,
      "remoteProfile": "default"
    }
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "syncOwner": "native",
    "remoteMode": "datafn-server"
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "native sync owner requires native-backed storage, remoteAdapter, and native config",
    "details": { "path": "sync.native" }
  }
}
```

# TV-API-003
- Description: Native-backed CloudKit mode validates successfully.
- Input:
```json
{
  "storage": "native-backed",
  "sync": {
    "owner": "native",
    "mode": "sync",
    "offlinability": true,
    "remoteAdapter": "native-backed-remote-adapter",
    "native": {
      "syncController": "native-sync-controller",
      "remoteMode": "icloud",
      "expectedSchemaHash": "abc123",
      "failIfUnavailable": true
    }
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "syncOwner": "native",
    "remoteMode": "icloud"
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "native icloud mode forbids direct JavaScript remote ownership",
    "details": { "path": "sync.remote" }
  }
}
```

# TV-BRG-001
- Description: Bridge handshake succeeds with matching protocol and schema hash.
- Input:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-1",
  "method": "handshake",
  "payload": {
    "schemaHash": "abc123",
    "namespace": "org-1:user-1",
    "clientId": "device-1",
    "remoteMode": "datafn-server",
    "remoteProfile": "default"
  }
}
```
- Expected output:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-1",
  "ok": true,
  "result": {
    "bridgeVersion": 1,
    "schemaHash": "abc123",
    "namespace": "org-1:user-1",
    "storageBackend": "coredata",
    "syncOwner": "native",
    "remoteMode": "datafn-server",
    "indexedDbDisabled": true
  }
}
```
- Negative variant(s):
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-1",
  "ok": false,
  "error": {
    "code": "BRIDGE_UNAVAILABLE",
    "message": "Native bridge bus is not available",
    "details": { "path": "window.webkit.messageHandlers.datafn" }
  }
}
```

# TV-BRG-002
- Description: Unsupported bridge method is rejected.
- Input:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-9",
  "method": "native.eval",
  "payload": { "code": "alert(1)" }
}
```
- Expected output:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-9",
  "ok": false,
  "error": {
    "code": "BRIDGE_METHOD_UNSUPPORTED",
    "message": "Unsupported bridge method",
    "details": { "path": "method", "method": "native.eval" }
  }
}
```
- Negative variant(s):
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-9",
  "ok": false,
  "error": {
    "code": "BRIDGE_PROTOCOL_MISMATCH",
    "message": "Bridge protocol version mismatch",
    "details": { "path": "protocol" }
  }
}
```

# TV-BRG-003
- Description: Schema hash mismatch fails fast.
- Input:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-2",
  "method": "handshake",
  "payload": {
    "schemaHash": "web-hash",
    "namespace": "org-1:user-1",
    "clientId": "device-1",
    "remoteMode": "icloud"
  }
}
```
- Expected output:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-2",
  "ok": false,
  "error": {
    "code": "BRIDGE_PROTOCOL_MISMATCH",
    "message": "Schema hash mismatch",
    "details": { "path": "payload.schemaHash" }
  }
}
```
- Negative variant(s):
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-2",
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "namespace is required",
    "details": { "path": "payload.namespace" }
  }
}
```

# TV-STO-001
- Description: Core Data-backed storage implements full DataFn semantics.
- Input:
```json
{
  "operations": [
    "storage.upsertRecord(tasks, {\"id\":\"task:1\",\"title\":\"A\"})",
    "storage.mergeRecord(tasks, task:1, {\"meta\":{\"p\":1}})",
    "storage.changelogAppend({\"clientId\":\"d1\",\"mutationId\":\"m1\"})",
    "storage.healthCheck()"
  ]
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "record": { "id": "task:1", "title": "A", "meta": { "p": 1 } },
    "changelogSeq": 1,
    "health": { "ok": true, "issues": [] }
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL",
    "message": "Atomic merge failed",
    "details": { "path": "storage.mergeRecord" }
  }
}
```

# TV-STO-002
- Description: Ordering and namespace isolation stay deterministic.
- Input:
```json
{
  "namespaceA": ["task:2", "task:1"],
  "namespaceB": ["task:1"]
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "namespaceA.listRecords": ["task:1", "task:2"],
    "namespaceB.listRecords": ["task:1"],
    "crossNamespaceLeak": false
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "Namespace isolation violated",
    "details": { "path": "namespace" }
  }
}
```

# TV-QRY-001
- Description: Ready resource query uses native-backed local storage.
- Input:
```json
{
  "resource": "tasks",
  "hydrationState": "ready",
  "query": {
    "resource": "tasks",
    "filters": { "completed": false }
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "source": "local-storage",
    "data": []
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_UNKNOWN_RESOURCE",
    "message": "Unknown resource",
    "details": { "path": "query.resource" }
  }
}
```

# TV-QRY-002
- Description: Hydrating resource query routes through the native-backed remote adapter.
- Input:
```json
{
  "resource": "tasks",
  "hydrationState": "hydrating",
  "query": {
    "resource": "tasks",
    "filters": { "completed": false }
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "source": "native-remote-adapter",
    "data": []
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "BRIDGE_UNAVAILABLE",
    "message": "Native remote adapter unavailable during hydration fallback",
    "details": { "path": "sync.remoteAdapter" }
  }
}
```

# TV-QRY-003
- Description: Remote-only resource works in native-backed DataFn-server mode.
- Input:
```json
{
  "mode": "datafn-server",
  "query": {
    "resource": "auditLogs",
    "filters": { "kind": "auth" }
  },
  "resourceMeta": { "isRemoteOnly": true }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "source": "native-remote-adapter",
    "data": []
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Native remote profile not found",
    "details": { "path": "sync.native.remoteProfile" }
  }
}
```

# TV-QRY-004
- Description: Remote-only resource is rejected in CloudKit mode.
- Input:
```json
{
  "mode": "icloud",
  "query": {
    "resource": "auditLogs"
  },
  "resourceMeta": { "isRemoteOnly": true }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_UNSUPPORTED",
    "message": "Remote-only resource is unsupported in icloud mode",
    "details": { "path": "query.resource", "resource": "auditLogs" }
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_UNKNOWN_RESOURCE",
    "message": "Unknown resource",
    "details": { "path": "query.resource" }
  }
}
```

# TV-MUT-001
- Description: Ready-resource mutation updates Core Data and schedules native sync.
- Input:
```json
{
  "hydrationState": "ready",
  "mutation": {
    "resource": "tasks",
    "operation": "merge",
    "id": "task:1",
    "record": { "completed": true }
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "storageBackend": "coredata",
    "changelogAppended": true,
    "schedulePushCalled": true
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "BRIDGE_UNAVAILABLE",
    "message": "Native sync controller unavailable for schedulePush",
    "details": { "path": "sync.native.syncController" }
  }
}
```

# TV-MUT-002
- Description: Native-backed mode does not create IndexedDB persistence.
- Input:
```json
{
  "mode": "native-backed",
  "mutation": {
    "resource": "tasks",
    "operation": "insert",
    "record": { "title": "A" }
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "indexedDbTouched": false,
    "storageBackend": "coredata"
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "IndexedDB persistence detected in native-backed mode",
    "details": { "path": "storage" }
  }
}
```

# TV-SYN-001
- Description: Native sync lifecycle delegates correctly.
- Input:
```json
{
  "calls": ["start", "pullNow", "cloneNow", "reconcileNow", "stop"]
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "delegated": ["start", "pullNow", "cloneNow", "reconcileNow", "stop"],
    "jsSyncEngineStarted": false
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL",
    "message": "JavaScript SyncEngine started in native-owned mode",
    "details": { "path": "sync.owner" }
  }
}
```

# TV-SYN-002
- Description: Browser-owned mode still uses JS-owned sync and IndexedDB.
- Input:
```json
{
  "sync": { "owner": "javascript", "mode": "sync" },
  "storage": "indexeddb"
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "jsSyncEngineStarted": true,
    "storageBackend": "indexeddb"
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "Browser-owned mode unexpectedly delegated to native",
    "details": { "path": "sync.owner" }
  }
}
```

# TV-SYN-003
- Description: Native-backed mode fails fast when bridge prerequisites are missing.
- Input:
```json
{
  "sync": {
    "owner": "native",
    "mode": "sync",
    "offlinability": true,
    "native": { "remoteMode": "datafn-server", "failIfUnavailable": true }
  }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": {
    "code": "BRIDGE_UNAVAILABLE",
    "message": "Native-backed mode requires an available bridge",
    "details": { "path": "sync.native" }
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "native sync owner requires native-backed storage, remoteAdapter, and native config",
    "details": { "path": "sync.native" }
  }
}
```

# TV-SYN-004
- Description: Swift DataFn-server sync uses the Core Data changelog and cursors.
- Input:
```json
{
  "backend": "datafn-server",
  "namespace": "org-1:user-1",
  "changelogCount": 2
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "pushReadFromCoreData": true,
    "pullUpdatedCoreDataCursors": true,
    "event": "sync.status"
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "TRANSPORT_ERROR",
    "message": "DataFn server sync failed",
    "details": { "path": "sync.push" }
  }
}
```

# TV-CLD-001
- Description: CloudKit mode syncs one namespace across two personal devices.
- Input:
```json
{
  "backend": "icloud",
  "containerIdentifier": "iCloud.com.example.app",
  "databaseScope": "private",
  "mutation": {
    "resource": "tasks",
    "operation": "insert",
    "record": { "id": "task:1", "title": "Across devices" }
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "deviceA.localWrite": true,
    "deviceB.receivedRecord": { "id": "task:1", "title": "Across devices" },
    "datafnServerContacted": false
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "ICLOUD_UNAVAILABLE",
    "message": "iCloud account is unavailable",
    "details": { "path": "sync.native.remoteMode" }
  }
}
```

# TV-CLD-002
- Description: CloudKit mode rejects direct JS DataFn-server remote ownership.
- Input:
```json
{
  "sync": {
    "owner": "native",
    "mode": "sync",
    "remote": "https://api.example.com/datafn",
    "native": { "remoteMode": "icloud" }
  }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "native icloud mode forbids direct JavaScript remote ownership",
    "details": { "path": "sync.remote" }
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "ICLOUD_UNAVAILABLE",
    "message": "CloudKit private database unavailable",
    "details": { "path": "sync.native.remoteMode" }
  }
}
```

# TV-CLD-003
- Description: Same-store dual backend configuration is rejected.
- Input:
```json
{
  "namespace": "org-1:user-1",
  "storeRoot": "AppSupport/datafn",
  "backends": ["datafn-server", "icloud"]
}
```
- Expected output:
```json
{
  "ok": false,
  "error": {
    "code": "NATIVE_SYNC_CONFLICT",
    "message": "A namespace store may only use one remote sync backend",
    "details": { "path": "sync.native.remoteMode" }
  }
}
```
- Negative variant(s):
```json
{
  "ok": true,
  "result": {
    "namespaceStore": "separate",
    "conflict": false
  }
}
```

# TV-SWUI-001
- Description: SwiftUI observers update from the same store used by WebView.
- Input:
```json
{
  "namespace": "org-1:user-1",
  "swiftUIView": "DatafnObservedQuery(tasks)",
  "webMutation": {
    "resource": "tasks",
    "operation": "insert",
    "record": { "id": "task:9", "title": "Shared store" }
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "swiftUIViewSawTask9": true
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "SwiftUI binding is not observing the shared namespace store",
    "details": { "path": "DatafnObservedQuery" }
  }
}
```

# TV-AUTH-001
- Description: Native server-backed mode applies auth configuration without exposing secrets in bridge events.
- Input:
```json
{
  "backend": "datafn-server",
  "auth": {
    "profileID": "default",
    "bearerTokenProvider": "native-only"
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "requestAuthorized": true,
    "bridgePayloadContainsToken": false
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Remote profile is unauthorized",
    "details": { "path": "sync.native.remoteProfile" }
  }
}
```

# TV-SEC-001
- Description: Native bridge logs and events redact sensitive auth details.
- Input:
```json
{
  "headers": {
    "Authorization": "Bearer secret-token"
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "loggedHeaders": {
      "Authorization": "[REDACTED]"
    }
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL",
    "message": "Sensitive auth material was emitted",
    "details": { "path": "observability.logs" }
  }
}
```

# TV-EVT-001
- Description: Native storage and sync changes propagate back to JS and SwiftUI observers.
- Input:
```json
{
  "event": {
    "protocol": "datafn-bridge/v1",
    "event": "storage.changed",
    "payload": {
      "resource": "tasks",
      "ids": ["task:1"]
    }
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "jsSignalInvalidated": true,
    "swiftObserverInvalidated": true
  }
}
```
- Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL",
    "message": "Observers were not invalidated",
    "details": { "path": "events" }
  }
}
```

# TV-OBS-001
- Description: Health report includes backend and redacted issue details.
- Input:
```json
{
  "mode": "native",
  "remoteMode": "icloud"
}
```
- Expected output:
```json
{
  "ok": true,
  "result": {
    "mode": "native",
    "storageBackend": "coredata",
    "syncOwner": "native",
    "remoteMode": "icloud",
    "issues": []
  }
}
```
- Negative variant(s):
```json
{
  "ok": true,
  "result": {
    "mode": "native",
    "issues": [
      {
        "code": "ICLOUD_UNAVAILABLE",
        "message": "iCloud account is unavailable",
        "details": { "path": "sync.native.remoteMode" }
      }
    ]
  }
}
```

