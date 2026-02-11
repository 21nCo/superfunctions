## TEST_VECTORS — CloneUp

All vectors assume a TypeScript client implementing `sync.cloneUp()` per `SPEC.md`.

### TV-CLONEUP-001

- **Description**: Default `cloneUp()` uploads in-scope records + many-many join rows, then performs `pullAfter`, advances `__global_cursor__`, clears changelog, and emits `sync_applied`.
- **Input**:

```json
{
  "call": { "options": null },
  "clientId": "client:device-1",
  "syncConfig": { "pushBatchSize": 100, "pushMaxRetries": 3 },
  "schema": {
    "resources": [
      {
        "name": "tasks",
        "version": 1,
        "fields": [{ "name": "title", "type": "string", "required": true }]
      },
      {
        "name": "tags",
        "version": 1,
        "fields": [{ "name": "name", "type": "string", "required": true }]
      },
      {
        "name": "billing",
        "version": 1,
        "isRemoteOnly": true,
        "fields": [{ "name": "plan", "type": "string", "required": true }]
      }
    ],
    "relations": [
      {
        "type": "many-many",
        "from": "tasks",
        "to": "tags",
        "relation": "tags",
        "metadata": [{ "name": "order", "type": "number", "required": false }]
      }
    ]
  },
  "storage": {
    "cursors": { "__global_cursor__": "0" },
    "records": {
      "tasks": [{ "id": "tasks:t1", "title": "Build feature" }],
      "tags": [{ "id": "tags:tag1", "name": "frontend" }]
    },
    "joinRows": {
      "join_tasks_tags_tags": [{ "from": "tasks:t1", "to": "tags:tag1", "order": 1 }]
    },
    "changelog": [
      {
        "seq": 1,
        "clientId": "client:device-1",
        "mutationId": "offline:m1",
        "timestampMs": 1,
        "mutation": { "resource": "tasks", "operation": "merge", "id": "tasks:t_local", "record": { "title": "Local" } }
      },
      {
        "seq": 2,
        "clientId": "client:device-1",
        "mutationId": "offline:m2",
        "timestampMs": 2,
        "mutation": { "resource": "tags", "operation": "merge", "id": "tags:t_local", "record": { "name": "Local" } }
      }
    ]
  },
  "remoteResponses": {
    "push": [
      {
        "ok": true,
        "result": {
          "ok": true,
          "applied": ["cloneup:rec:tasks:tasks:t1:1onhffr"],
          "errors": [],
          "cursor": "10"
        }
      },
      {
        "ok": true,
        "result": {
          "ok": true,
          "applied": ["cloneup:rec:tags:tags:tag1:18wro6k"],
          "errors": [],
          "cursor": "11"
        }
      },
      {
        "ok": true,
        "result": {
          "ok": true,
          "applied": ["cloneup:rel:join_tasks_tags_tags:tasks:t1:tags:tag1:uopwd"],
          "errors": [],
          "cursor": "12"
        }
      }
    ],
    "pull": [
      {
        "ok": true,
        "result": {
          "ok": true,
          "changes": [
            {
              "serverSeq": 11,
              "resource": "tasks",
              "id": "tasks:t1",
              "op": "upsert",
              "record": { "id": "tasks:t1", "title": "Build feature" }
            },
            {
              "serverSeq": 12,
              "resource": "tags",
              "id": "tags:tag1",
              "op": "upsert",
              "record": { "id": "tags:tag1", "name": "frontend" }
            }
          ],
          "nextCursor": null
        }
      }
    ]
  }
}
```

- **Expected output**:

```json
{
  "result": {
    "ok": true,
    "cursor": "12",
    "stats": {
      "resources": {
        "tasks": { "records": 1, "mutations": 1 },
        "tags": { "records": 1, "mutations": 1 }
      },
      "joinStores": {
        "join_tasks_tags_tags": { "rows": 1, "mutations": 1 }
      },
      "batches": 3
    },
    "errors": []
  },
  "expectedRemoteCalls": [
    {
      "method": "push",
      "payload": {
        "clientId": "client:device-1",
        "mutations": [
          {
            "resource": "tasks",
            "version": 1,
            "operation": "merge",
            "id": "tasks:t1",
            "record": { "title": "Build feature" },
            "clientId": "client:device-1",
            "mutationId": "cloneup:rec:tasks:tasks:t1:1onhffr"
          }
        ]
      }
    },
    {
      "method": "push",
      "payload": {
        "clientId": "client:device-1",
        "mutations": [
          {
            "resource": "tags",
            "version": 1,
            "operation": "merge",
            "id": "tags:tag1",
            "record": { "name": "frontend" },
            "clientId": "client:device-1",
            "mutationId": "cloneup:rec:tags:tags:tag1:18wro6k"
          }
        ]
      }
    },
    {
      "method": "push",
      "payload": {
        "clientId": "client:device-1",
        "mutations": [
          {
            "resource": "tasks",
            "version": 1,
            "operation": "relate",
            "id": "tasks:t1",
            "relations": { "tags": { "$ref": "tags:tag1", "order": 1 } },
            "clientId": "client:device-1",
            "mutationId": "cloneup:rel:join_tasks_tags_tags:tasks:t1:tags:tag1:uopwd"
          }
        ]
      }
    },
    {
      "method": "pull",
      "payload": { "clientId": "client:device-1", "cursor": "0", "limit": 100 }
    }
  ],
  "expectedStorageEffects": {
    "finalCursors": { "__global_cursor__": "12" },
    "changelogEmptied": true
  },
  "expectedEvents": [
    {
      "type": "sync_applied",
      "context": {
        "phase": "cloneup",
        "cursor": "12",
        "stats": {
          "resources": {
            "tasks": { "records": 1, "mutations": 1 },
            "tags": { "records": 1, "mutations": 1 }
          },
          "joinStores": {
            "join_tasks_tags_tags": { "rows": 1, "mutations": 1 }
          },
          "batches": 3
        }
      }
    }
  ]
}
```

---

### TV-CLONEUP-002

- **Description**: `options.resources` limits record upload scope; unknown resource is rejected.
- **Input**:

```json
{
  "call": { "options": { "resources": ["tags"], "pullAfter": false } },
  "clientId": "client:device-1",
  "syncConfig": { "pushBatchSize": 100, "pushMaxRetries": 3 },
  "schema": {
    "resources": [
      { "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string", "required": true }] },
      { "name": "tags", "version": 1, "fields": [{ "name": "name", "type": "string", "required": true }] }
    ],
    "relations": [
      { "type": "many-many", "from": "tasks", "to": "tags", "relation": "tags", "metadata": [{ "name": "order", "type": "number" }] }
    ]
  },
  "storage": {
    "cursors": { "__global_cursor__": "0" },
    "records": {
      "tasks": [{ "id": "tasks:t1", "title": "Build feature" }],
      "tags": [{ "id": "tags:tag1", "name": "frontend" }]
    },
    "joinRows": { "join_tasks_tags_tags": [{ "from": "tasks:t1", "to": "tags:tag1", "order": 1 }] },
    "changelog": []
  },
  "remoteResponses": {
    "push": [
      {
        "ok": true,
        "result": { "ok": true, "applied": ["cloneup:rec:tags:tags:tag1:18wro6k"], "errors": [], "cursor": "7" }
      }
    ]
  }
}
```

- **Expected output**:

```json
{
  "result": {
    "ok": true,
    "cursor": "7",
    "stats": {
      "resources": { "tags": { "records": 1, "mutations": 1 } },
      "joinStores": {},
      "batches": 1
    },
    "errors": []
  },
  "expectedRemoteCalls": [
    {
      "method": "push",
      "payload": {
        "clientId": "client:device-1",
        "mutations": [
          {
            "resource": "tags",
            "version": 1,
            "operation": "merge",
            "id": "tags:tag1",
            "record": { "name": "frontend" },
            "clientId": "client:device-1",
            "mutationId": "cloneup:rec:tags:tags:tag1:18wro6k"
          }
        ]
      }
    }
  ],
  "expectedStorageEffects": {
    "finalCursors": { "__global_cursor__": "7" }
  }
}
```

- **Negative variant**:
  - **Input**: `options.resources = ["wat"]`
  - **Expected output**:

```json
{
  "throws": {
    "code": "DFQL_UNKNOWN_RESOURCE",
    "message": "Invalid cloneUp: unknown resource",
    "details": { "path": "resources[0]" }
  }
}
```

---

### TV-CLONEUP-003

- **Description**: Missing storage prerequisite is rejected.
- **Input**:

```json
{
  "call": { "options": null },
  "clientId": "client:device-1",
  "syncConfig": { "remote": "http://example.com" },
  "schema": { "resources": [{ "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] }], "relations": [] },
  "storage": null
}
```

- **Expected output**:

```json
{
  "throws": {
    "code": "DFQL_INVALID",
    "message": "Invalid cloneUp: storage is required",
    "details": { "path": "storage" }
  }
}
```

---

### TV-CLONEUP-004

- **Description**: Missing remote prerequisite is rejected.
- **Input**:

```json
{
  "call": { "options": null },
  "clientId": "client:device-1",
  "syncConfig": null,
  "schema": { "resources": [{ "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] }], "relations": [] },
  "storage": { "cursors": { "__global_cursor__": "0" }, "records": { "tasks": [] }, "joinRows": {}, "changelog": [] }
}
```

- **Expected output**:

```json
{
  "throws": {
    "code": "DFQL_INVALID",
    "message": "Invalid cloneUp: sync.remote is required",
    "details": { "path": "sync.remote" }
  }
}
```

---

### TV-CLONEUP-005

- **Description**: Remote-only resources are rejected when explicitly included in `options.resources`.
- **Input**:

```json
{
  "call": { "options": { "resources": ["tasks", "billing"] } },
  "clientId": "client:device-1",
  "syncConfig": { "remote": "http://example.com" },
  "schema": {
    "resources": [
      { "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] },
      { "name": "billing", "version": 1, "isRemoteOnly": true, "fields": [{ "name": "plan", "type": "string" }] }
    ],
    "relations": []
  },
  "storage": { "cursors": { "__global_cursor__": "0" }, "records": { "tasks": [] }, "joinRows": {}, "changelog": [] }
}
```

- **Expected output**:

```json
{
  "throws": {
    "code": "DFQL_INVALID",
    "message": "Invalid cloneUp: remote-only resources are not allowed",
    "details": { "path": "resources[1]" }
  }
}
```

---

### TV-CLONEUP-006

- **Description**: Cursor updates are monotonic and success emits exactly one `sync_applied` with `context.phase="cloneup"`.
- **Input**:

```json
{
  "call": { "options": { "includeManyMany": false, "pullAfter": false } },
  "clientId": "client:device-1",
  "syncConfig": { "pushBatchSize": 100, "pushMaxRetries": 3 },
  "schema": { "resources": [{ "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] }], "relations": [] },
  "storage": {
    "cursors": { "__global_cursor__": "10" },
    "records": { "tasks": [{ "id": "tasks:t1", "title": "Build feature" }] },
    "joinRows": {},
    "changelog": []
  },
  "remoteResponses": {
    "push": [
      {
        "ok": true,
        "result": { "ok": true, "applied": ["cloneup:rec:tasks:tasks:t1:1onhffr"], "errors": [], "cursor": "5" }
      }
    ]
  }
}
```

- **Expected output**:

```json
{
  "result": {
    "ok": true,
    "cursor": "5",
    "stats": { "resources": { "tasks": { "records": 1, "mutations": 1 } }, "joinStores": {}, "batches": 1 },
    "errors": []
  },
  "expectedStorageEffects": {
    "finalCursors": { "__global_cursor__": "10" }
  },
  "expectedEvents": [
    {
      "type": "sync_applied",
      "context": {
        "phase": "cloneup",
        "cursor": "5",
        "stats": { "resources": { "tasks": { "records": 1, "mutations": 1 } }, "joinStores": {}, "batches": 1 }
      }
    }
  ]
}
```

---

### TV-CLONEUP-007

- **Description**: Missing join stores are treated as empty and do not fail cloneUp.
- **Input**:

```json
{
  "call": { "options": { "pullAfter": false } },
  "clientId": "client:device-1",
  "syncConfig": { "pushBatchSize": 100, "pushMaxRetries": 3 },
  "schema": {
    "resources": [
      { "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] },
      { "name": "tags", "version": 1, "fields": [{ "name": "name", "type": "string" }] }
    ],
    "relations": [{ "type": "many-many", "from": "tasks", "to": "tags", "relation": "tags", "metadata": [{ "name": "order", "type": "number" }] }]
  },
  "storage": {
    "cursors": { "__global_cursor__": "0" },
    "records": {
      "tasks": [{ "id": "tasks:t1", "title": "Build feature" }],
      "tags": [{ "id": "tags:tag1", "name": "frontend" }]
    },
    "joinRows": {},
    "changelog": []
  },
  "remoteResponses": {
    "push": [
      { "ok": true, "result": { "ok": true, "applied": ["cloneup:rec:tasks:tasks:t1:1onhffr"], "errors": [], "cursor": "10" } },
      { "ok": true, "result": { "ok": true, "applied": ["cloneup:rec:tags:tags:tag1:18wro6k"], "errors": [], "cursor": "11" } }
    ]
  }
}
```

- **Expected output**:

```json
{
  "result": {
    "ok": true,
    "cursor": "11",
    "stats": {
      "resources": { "tasks": { "records": 1, "mutations": 1 }, "tags": { "records": 1, "mutations": 1 } },
      "joinStores": { "join_tasks_tags_tags": { "rows": 0, "mutations": 0 } },
      "batches": 2
    },
    "errors": []
  }
}
```

---

### TV-CLONEUP-008

- **Description**: Records missing a string `id` are rejected.
- **Input**:

```json
{
  "call": { "options": { "includeManyMany": false } },
  "clientId": "client:device-1",
  "syncConfig": { "remote": "http://example.com" },
  "schema": { "resources": [{ "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] }], "relations": [] },
  "storage": {
    "cursors": { "__global_cursor__": "0" },
    "records": { "tasks": [{ "title": "Missing id" }] },
    "joinRows": {},
    "changelog": []
  }
}
```

- **Expected output**:

```json
{
  "throws": {
    "code": "DFQL_INVALID",
    "message": "Invalid cloneUp: record id must be a string",
    "details": { "path": "records[0].id" }
  }
}
```

---

### TV-CLONEUP-009

- **Description**: Join row metadata keys not declared in schema are rejected (schema-bounded).
- **Input**:

```json
{
  "call": { "options": { "pullAfter": false } },
  "clientId": "client:device-1",
  "syncConfig": { "remote": "http://example.com" },
  "schema": {
    "resources": [
      { "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] },
      { "name": "tags", "version": 1, "fields": [{ "name": "name", "type": "string" }] }
    ],
    "relations": [
      { "type": "many-many", "from": "tasks", "to": "tags", "relation": "tags", "metadata": [{ "name": "order", "type": "number" }] }
    ]
  },
  "storage": {
    "cursors": { "__global_cursor__": "0" },
    "records": {
      "tasks": [{ "id": "tasks:t1", "title": "Build feature" }],
      "tags": [{ "id": "tags:tag1", "name": "frontend" }]
    },
    "joinRows": {
      "join_tasks_tags_tags": [{ "from": "tasks:t1", "to": "tags:tag1", "order": 1, "wat": "x" }]
    },
    "changelog": []
  },
  "remoteResponses": {
    "push": [
      { "ok": true, "result": { "ok": true, "applied": ["cloneup:rec:tasks:tasks:t1:1onhffr"], "errors": [], "cursor": "10" } },
      { "ok": true, "result": { "ok": true, "applied": ["cloneup:rec:tags:tags:tag1:18wro6k"], "errors": [], "cursor": "11" } }
    ]
  }
}
```

- **Expected output**:

```json
{
  "throws": {
    "code": "DFQL_UNKNOWN_FIELD",
    "message": "Invalid cloneUp: unknown join metadata field",
    "details": { "path": "joinRows[0].wat" }
  }
}
```

- **Negative variant**:
  - **Input**: join row `{ "from": null, "to": "tags:tag1" }`
  - **Expected output**:

```json
{
  "throws": {
    "code": "DFQL_INVALID",
    "message": "Invalid cloneUp: join row from/to must be a string",
    "details": { "path": "joinRows[0].from" }
  }
}
```

---

### TV-CLONEUP-010

- **Description**: Deterministic ordering + batching. Storage returns records unsorted; cloneUp sorts by id and batches deterministically.
- **Input**:

```json
{
  "call": { "options": { "includeManyMany": false, "pullAfter": false, "batchSize": 2 } },
  "clientId": "client:device-1",
  "syncConfig": { "remote": "http://example.com" },
  "schema": { "resources": [{ "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] }], "relations": [] },
  "storage": {
    "cursors": { "__global_cursor__": "0" },
    "records": {
      "tasks": [
        { "id": "tasks:t2", "title": "B" },
        { "id": "tasks:t1", "title": "A" },
        { "id": "tasks:t3", "title": "C" }
      ]
    },
    "joinRows": {},
    "changelog": []
  },
  "remoteResponses": {
    "push": [
      { "ok": true, "result": { "ok": true, "applied": ["cloneup:rec:tasks:tasks:t1:1s5wcym", "cloneup:rec:tasks:tasks:t2:bbqf1s"], "errors": [], "cursor": "1" } },
      { "ok": true, "result": { "ok": true, "applied": ["cloneup:rec:tasks:tasks:t3:1hhzg1e"], "errors": [], "cursor": "2" } }
    ]
  }
}
```

- **Expected output**:

```json
{
  "result": {
    "ok": true,
    "cursor": "2",
    "stats": {
      "resources": { "tasks": { "records": 3, "mutations": 3 } },
      "joinStores": {},
      "batches": 2
    },
    "errors": []
  },
  "expectedRemoteCalls": [
    {
      "method": "push",
      "payload": {
        "clientId": "client:device-1",
        "mutations": [
          { "resource": "tasks", "version": 1, "operation": "merge", "id": "tasks:t1", "record": { "title": "A" }, "clientId": "client:device-1", "mutationId": "cloneup:rec:tasks:tasks:t1:1s5wcym" },
          { "resource": "tasks", "version": 1, "operation": "merge", "id": "tasks:t2", "record": { "title": "B" }, "clientId": "client:device-1", "mutationId": "cloneup:rec:tasks:tasks:t2:bbqf1s" }
        ]
      }
    },
    {
      "method": "push",
      "payload": {
        "clientId": "client:device-1",
        "mutations": [
          { "resource": "tasks", "version": 1, "operation": "merge", "id": "tasks:t3", "record": { "title": "C" }, "clientId": "client:device-1", "mutationId": "cloneup:rec:tasks:tasks:t3:1hhzg1e" }
        ]
      }
    }
  ]
}
```

---

### TV-CLONEUP-011

- **Description**: Transport error retries for push batches; exhaustion throws `TRANSPORT_ERROR`.
- **Input**:

```json
{
  "call": { "options": { "includeManyMany": false, "pullAfter": false, "maxRetries": 1 } },
  "clientId": "client:device-1",
  "syncConfig": { "remote": "http://example.com" },
  "schema": { "resources": [{ "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] }], "relations": [] },
  "storage": { "cursors": { "__global_cursor__": "0" }, "records": { "tasks": [{ "id": "tasks:t1", "title": "Build feature" }] }, "joinRows": {}, "changelog": [] },
  "remoteResponses": {
    "push": [
      {
        "throws": {
          "code": "TRANSPORT_ERROR",
          "message": "network down",
          "details": { "path": "sync.push" }
        }
      },
      {
        "ok": true,
        "result": { "ok": true, "applied": ["cloneup:rec:tasks:tasks:t1:1onhffr"], "errors": [], "cursor": "10" }
      }
    ]
  }
}
```

- **Expected output**:

```json
{
  "result": {
    "ok": true,
    "cursor": "10",
    "stats": { "resources": { "tasks": { "records": 1, "mutations": 1 } }, "joinStores": {}, "batches": 2 },
    "errors": []
  }
}
```

- **Negative variant**:
  - **Input**: `maxRetries = 0` and remote throws the same transport error.
  - **Expected output**:

```json
{
  "throws": {
    "code": "TRANSPORT_ERROR",
    "details": { "path": "sync.push" }
  }
}
```

---

### TV-CLONEUP-012

- **Description**: Server-side push `errors[]` causes cloneUp to return `ok=false` and MUST NOT clear changelog nor advance cursors; emits `sync_failed`.
- **Input**:

```json
{
  "call": { "options": { "includeManyMany": true, "pullAfter": false, "failFast": true } },
  "clientId": "client:device-1",
  "syncConfig": { "remote": "http://example.com" },
  "schema": {
    "resources": [
      { "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] },
      { "name": "tags", "version": 1, "fields": [{ "name": "name", "type": "string" }] }
    ],
    "relations": [
      { "type": "many-many", "from": "tasks", "to": "tags", "relation": "tags", "metadata": [{ "name": "order", "type": "number" }] }
    ]
  },
  "storage": {
    "cursors": { "__global_cursor__": "0" },
    "records": {
      "tasks": [{ "id": "tasks:t1", "title": "Build feature" }],
      "tags": [{ "id": "tags:tag1", "name": "frontend" }]
    },
    "joinRows": {
      "join_tasks_tags_tags": [{ "from": "tasks:t1", "to": "tags:tag1", "order": 1 }]
    },
    "changelog": [
      { "seq": 1, "clientId": "client:device-1", "mutationId": "offline:m1", "timestampMs": 1, "mutation": { "resource": "tasks", "operation": "merge", "id": "tasks:t_local" } }
    ]
  },
  "remoteResponses": {
    "push": [
      {
        "ok": true,
        "result": {
          "ok": true,
          "applied": [],
          "errors": [
            {
              "mutationId": "cloneup:rec:tasks:tasks:t1:1onhffr",
              "code": "DFQL_INVALID",
              "message": "Invalid DFQL: title required",
              "path": "record.title"
            }
          ],
          "cursor": "10"
        }
      }
    ]
  }
}
```

- **Expected output**:

```json
{
  "result": {
    "ok": false,
    "cursor": "10",
    "stats": { "resources": { "tasks": { "records": 1, "mutations": 1 } }, "joinStores": {}, "batches": 1 },
    "errors": [
      {
        "mutationId": "cloneup:rec:tasks:tasks:t1:1onhffr",
        "code": "DFQL_INVALID",
        "message": "Invalid DFQL: title required",
        "path": "record.title"
      }
    ]
  },
  "expectedRemoteCalls": [
    {
      "method": "push",
      "payload": {
        "clientId": "client:device-1",
        "mutations": [
          {
            "resource": "tasks",
            "version": 1,
            "operation": "merge",
            "id": "tasks:t1",
            "record": { "title": "Build feature" },
            "clientId": "client:device-1",
            "mutationId": "cloneup:rec:tasks:tasks:t1:1onhffr"
          }
        ]
      }
    }
  ],
  "expectedStorageEffects": {
    "finalCursors": { "__global_cursor__": "0" },
    "changelogEmptied": false
  },
  "expectedEvents": [
    {
      "type": "sync_failed",
      "context": { "phase": "cloneup" }
    }
  ]
}
```

---

### TV-CLONEUP-013

- **Description**: Invalid `batchSize` / `maxRetries` values are rejected with `DFQL_INVALID`.
- **Input**:

```json
{
  "call": { "options": { "batchSize": 0 } },
  "clientId": "client:device-1",
  "syncConfig": { "remote": "http://example.com" },
  "schema": { "resources": [{ "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] }], "relations": [] },
  "storage": { "cursors": { "__global_cursor__": "0" }, "records": { "tasks": [] }, "joinRows": {}, "changelog": [] }
}
```

- **Expected output**:

```json
{
  "throws": {
    "code": "DFQL_INVALID",
    "message": "Invalid cloneUp: batchSize must be a positive integer",
    "details": { "path": "batchSize" }
  }
}
```

- **Negative variant**:
  - **Input**: `options.maxRetries = -1`
  - **Expected output**:

```json
{
  "throws": {
    "code": "DFQL_INVALID",
    "message": "Invalid cloneUp: maxRetries must be a non-negative integer",
    "details": { "path": "maxRetries" }
  }
}
```

---

### TV-CLONEUP-014

- **Description**: Missing remote method (protocol incompatibility) throws `TRANSPORT_ERROR` with `details.path="sync.push"`.
- **Input**:

```json
{
  "call": { "options": { "includeManyMany": false } },
  "clientId": "client:device-1",
  "schema": { "resources": [{ "name": "tasks", "version": 1, "fields": [{ "name": "title", "type": "string" }] }], "relations": [] },
  "storage": { "cursors": { "__global_cursor__": "0" }, "records": { "tasks": [{ "id": "tasks:t1", "title": "Build feature" }] }, "joinRows": {}, "changelog": [] },
  "remote": { "push": null }
}
```

- **Expected output**:

```json
{
  "throws": {
    "code": "TRANSPORT_ERROR",
    "details": { "path": "sync.push" }
  }
}
```

