# Test Vectors

## TV-CON-001-P
- Vector ID: TV-CON-001-P
- Description: Core and server SearchProvider typings accept all three search options.
- Input:
```ts
const provider: SearchProvider = {
  name: "p",
  search: async (p) => {
    p.prefix;
    p.fuzzy;
    p.fieldBoosts;
    return [];
  },
  searchAll: async (p) => {
    p.prefix;
    p.fuzzy;
    p.fieldBoosts;
    return [];
  },
  updateIndices: async () => {},
};
```
- Expected output:
```json
{ "typecheck": "pass" }
```
- Negative variant(s): See TV-CON-001-N.

## TV-CON-001-N
- Vector ID: TV-CON-001-N
- Description: Invalid search option types fail typecheck.
- Input:
```ts
await provider.search({
  resource: "todos",
  query: "test",
  prefix: "yes",
  fuzzy: "0.2",
  fieldBoosts: { title: "2" },
});
```
- Expected output:
```json
{ "typecheck": "fail", "error": "Type mismatch for prefix/fuzzy/fieldBoosts" }
```
- Negative variant(s): N/A.

## TV-CON-002-P
- Vector ID: TV-CON-002-P
- Description: Server DFQL and cross-resource params carry options end-to-end.
- Input:
```json
{
  "query": {
    "resource": "todos",
    "version": 1,
    "search": {
      "query": "test",
      "prefix": true,
      "fuzzy": 0.2,
      "fieldBoosts": { "text": 2 }
    }
  }
}
```
- Expected output:
```json
{
  "providerCall": {
    "prefix": true,
    "fuzzy": 0.2,
    "fieldBoosts": { "text": 2 }
  }
}
```
- Negative variant(s): See TV-CON-002-N.

## TV-CON-002-N
- Vector ID: TV-CON-002-N
- Description: Missing type fields in server contracts would cause compile/runtime mismatch.
- Input:
```json
{
  "query": {
    "resource": "todos",
    "version": 1,
    "search": { "query": "test", "prefix": true }
  }
}
```
- Expected output:
```json
{
  "typecheck": "fail when contracts lack prefix",
  "error": "Property 'prefix' does not exist"
}
```
- Negative variant(s): N/A.

## TV-CON-003-P
- Vector ID: TV-CON-003-P
- Description: Canonical client/server request envelopes accept all options.
- Input:
```json
{
  "query": "test",
  "resources": ["todos"],
  "prefix": true,
  "fuzzy": true,
  "fieldBoosts": { "text": 2 }
}
```
- Expected output:
```json
{ "ok": true }
```
- Negative variant(s): See TV-CON-003-N.

## TV-CON-003-N
- Vector ID: TV-CON-003-N
- Description: Invalid request envelope is rejected canonically.
- Input:
```json
{
  "query": "test",
  "prefix": "true",
  "fuzzy": -1,
  "fieldBoosts": ["text", 2]
}
```
- Expected output:
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "Invalid request: prefix must be boolean",
    "details": { "path": "prefix" }
  }
}
```
- Negative variant(s): `fuzzy=-1` and array `fieldBoosts` also fail with path-specific `DFQL_INVALID`.

## TV-CLI-001-P
- Vector ID: TV-CLI-001-P
- Description: Client validates and accepts valid options.
- Input:
```json
{
  "query": "test",
  "prefix": true,
  "fuzzy": 0.2,
  "fieldBoosts": { "text": 2, "name": 1 }
}
```
- Expected output:
```json
{ "clientValidation": "pass" }
```
- Negative variant(s): See TV-CLI-001-N.

## TV-CLI-001-N
- Vector ID: TV-CLI-001-N
- Description: Client rejects invalid option values.
- Input:
```json
{
  "query": "test",
  "prefix": 1,
  "fuzzy": "auto",
  "fieldBoosts": { "text": 0 }
}
```
- Expected output:
```json
{
  "code": "DFQL_INVALID",
  "message": "Invalid request: prefix must be boolean",
  "details": { "path": "prefix" }
}
```
- Negative variant(s): `fieldBoosts.text=0` returns `DFQL_INVALID` at `fieldBoosts.text`.

## TV-CLI-002-P
- Vector ID: TV-CLI-002-P
- Description: Client forwards options unchanged to both local and remote search paths.
- Input:
```json
{
  "request": {
    "query": "test",
    "prefix": true,
    "fuzzy": 0.3,
    "fieldBoosts": { "text": 2 },
    "source": "auto"
  },
  "runtime": {
    "hasSearchProvider": true,
    "online": true
  }
}
```
- Expected output:
```json
{
  "localProviderCall": {
    "prefix": true,
    "fuzzy": 0.3,
    "fieldBoosts": { "text": 2 }
  }
}
```
- Negative variant(s): See TV-CLI-002-N.

## TV-CLI-002-N
- Vector ID: TV-CLI-002-N
- Description: Option drop regression check fails when forwarded payload misses fields.
- Input:
```json
{
  "request": {
    "query": "test",
    "prefix": true,
    "fuzzy": true,
    "fieldBoosts": { "text": 2 }
  }
}
```
- Expected output:
```json
{
  "assertion": "search provider call includes prefix/fuzzy/fieldBoosts",
  "result": "fail if any field undefined"
}
```
- Negative variant(s): N/A.

## TV-CLI-003-P
- Vector ID: TV-CLI-003-P
- Description: Client defaults to local-first in auto mode and supports explicit source override.
- Input:
```json
{
  "request": { "query": "test", "source": "auto" },
  "runtime": { "hasSearchProvider": true, "hasRemote": true, "online": true }
}
```
- Expected output:
```json
{ "pathSelected": "local" }
```
- Negative variant(s): See TV-CLI-003-N.

## TV-CLI-003-N
- Vector ID: TV-CLI-003-N
- Description: Unsupported explicit source path returns canonical error.
- Input:
```json
{
  "request": { "query": "test", "source": "remote" },
  "runtime": { "hasSearchProvider": true, "hasRemote": false, "online": false }
}
```
- Expected output:
```json
{
  "code": "DFQL_UNSUPPORTED",
  "message": "Remote search unavailable",
  "details": { "path": "source" }
}
```
- Negative variant(s): invalid `source: "edge"` returns `DFQL_INVALID`.

## TV-IDX-001-P
- Vector ID: TV-IDX-001-P
- Description: Local mutation success triggers deterministic index updates.
- Input:
```json
{
  "mutations": [
    { "operation": "insert", "resource": "todos", "id": "t1", "record": { "text": "testing" } },
    { "operation": "delete", "resource": "todos", "id": "t2" }
  ]
}
```
- Expected output:
```json
{
  "updateIndicesCalls": [
    { "resource": "todos", "operation": "upsert", "records": [{ "id": "t1", "text": "testing" }] },
    { "resource": "todos", "operation": "delete", "records": [{ "id": "t2" }] }
  ]
}
```
- Negative variant(s): See TV-IDX-001-N.

## TV-IDX-001-N
- Vector ID: TV-IDX-001-N
- Description: Non-indexed operations do not trigger search index updates.
- Input:
```json
{
  "mutation": { "operation": "share", "resource": "todos", "id": "t1", "shareWith": { "userId": "u2" } }
}
```
- Expected output:
```json
{ "updateIndicesCalls": [] }
```
- Negative variant(s): N/A.

## TV-IDX-002-P
- Vector ID: TV-IDX-002-P
- Description: Index update failures are fail-soft and observable.
- Input:
```json
{
  "mutation": { "operation": "insert", "resource": "todos", "id": "t1", "record": { "text": "x" } },
  "updateIndicesThrows": "disk full"
}
```
- Expected output:
```json
{
  "mutationResult": { "ok": true },
  "log": { "level": "warn", "resource": "todos", "operation": "search-index-update" }
}
```
- Negative variant(s): See TV-IDX-002-N.

## TV-IDX-002-N
- Vector ID: TV-IDX-002-N
- Description: Regression guard: mutation must not fail because index update failed.
- Input:
```json
{
  "mutation": { "operation": "merge", "resource": "todos", "id": "t1", "record": { "text": "new" } },
  "updateIndicesThrows": "any"
}
```
- Expected output:
```json
{
  "assertion": "mutation throws",
  "result": "must be false"
}
```
- Negative variant(s): N/A.

## TV-SRV-001-P
- Vector ID: TV-SRV-001-P
- Description: Server execution forwards options for both per-resource and cross-resource provider calls.
- Input:
```json
{
  "querySearch": {
    "resource": "todos",
    "search": { "query": "test", "prefix": true, "fuzzy": true, "fieldBoosts": { "text": 2 } }
  },
  "crossSearch": {
    "query": "test",
    "resources": ["todos"],
    "prefix": true,
    "fuzzy": 0.2,
    "fieldBoosts": { "text": 2 }
  }
}
```
- Expected output:
```json
{
  "provider.search": { "prefix": true, "fuzzy": true, "fieldBoosts": { "text": 2 } },
  "provider.searchAll": { "prefix": true, "fuzzy": 0.2, "fieldBoosts": { "text": 2 } }
}
```
- Negative variant(s): See TV-SRV-001-N.

## TV-SRV-001-N
- Vector ID: TV-SRV-001-N
- Description: Option-drop regression assertion for server execution.
- Input:
```json
{
  "querySearch": { "resource": "todos", "search": { "query": "test", "prefix": true } }
}
```
- Expected output:
```json
{ "assertion": "provider.search receives prefix=true", "result": "fail if undefined" }
```
- Negative variant(s): N/A.

## TV-SRV-002-P
- Vector ID: TV-SRV-002-P
- Description: `/datafn/search` route accepts and validates all new options.
- Input:
```json
{
  "query": "test",
  "prefix": true,
  "fuzzy": 0.2,
  "fieldBoosts": { "text": 2 }
}
```
- Expected output:
```json
{ "ok": true }
```
- Negative variant(s): See TV-SRV-002-N.

## TV-SRV-002-N
- Vector ID: TV-SRV-002-N
- Description: Route rejects invalid option payloads deterministically.
- Input:
```json
{
  "query": "test",
  "prefix": "true",
  "fuzzy": -1,
  "fieldBoosts": { "text": "2" }
}
```
- Expected output:
```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "Invalid request: prefix must be boolean",
    "details": { "path": "prefix" }
  }
}
```
- Negative variant(s): `fuzzy=-1` and non-numeric fieldBoost values produce path-specific `DFQL_INVALID`.

## TV-UNI-001-P
- Vector ID: TV-UNI-001-P
- Description: `clientSearch` plugin with configured provider delegates candidate lookup to provider.
- Input:
```json
{
  "pluginConfig": { "searchProvider": "mock" },
  "query": {
    "resource": "todos",
    "search": { "query": "tes", "prefix": true, "fuzzy": 0.2, "fieldBoosts": { "text": 2 } }
  }
}
```
- Expected output:
```json
{
  "provider.searchCall": {
    "resource": "todos",
    "query": "tes",
    "prefix": true,
    "fuzzy": 0.2,
    "fieldBoosts": { "text": 2 }
  },
  "queryFilterInjected": { "id": { "in": ["t1", "t2"] } }
}
```
- Negative variant(s): See TV-UNI-001-N.

## TV-UNI-001-N
- Vector ID: TV-UNI-001-N
- Description: Provider-delegation mode must not instantiate MiniSearch.
- Input:
```json
{ "pluginConfig": { "searchProvider": "mock" } }
```
- Expected output:
```json
{ "assertion": "MiniSearch constructor called", "result": "must be false" }
```
- Negative variant(s): N/A.

## TV-UNI-002-P
- Vector ID: TV-UNI-002-P
- Description: Legacy plugin mode still works without provider.
- Input:
```json
{
  "pluginConfig": {},
  "query": { "resource": "todos", "search": "test" }
}
```
- Expected output:
```json
{ "pluginMode": "legacy-minisearch", "ok": true }
```
- Negative variant(s): See TV-UNI-002-N.

## TV-UNI-002-N
- Vector ID: TV-UNI-002-N
- Description: Provider-enabled mode takes precedence and legacy-only behavior is deprecated.
- Input:
```json
{
  "pluginConfig": { "searchProvider": "mock" },
  "legacyMinisearchOptions": { "fuzzy": 0.2, "prefix": true }
}
```
- Expected output:
```json
{ "deprecationNotice": "legacy MiniSearch path ignored when provider exists" }
```
- Negative variant(s): N/A.

## TV-EX-001-P
- Vector ID: TV-EX-001-P
- Description: Todo example finds "testing" when searching "test" in local-first mode.
- Input:
```json
{
  "mode": "sync",
  "clientSearchCall": {
    "query": "test",
    "resources": ["todos", "categories"],
    "prefix": true,
    "fuzzy": 0.2,
    "fieldBoosts": { "text": 2, "name": 1 },
    "source": "auto"
  },
  "records": [{ "id": "todo:1", "text": "testing" }]
}
```
- Expected output:
```json
{
  "results": [{ "id": "todo:1", "resource": "todos" }],
  "pathSelected": "local"
}
```
- Negative variant(s): See TV-EX-001-N.

## TV-EX-001-N
- Vector ID: TV-EX-001-N
- Description: Example app in explicit remote mode fails cleanly when remote search is unavailable.
- Input:
```json
{
  "clientSearchCall": { "query": "test", "source": "remote" },
  "runtime": { "remoteSearchAvailable": false }
}
```
- Expected output:
```json
{
  "code": "DFQL_UNSUPPORTED",
  "message": "Remote search unavailable"
}
```
- Negative variant(s): N/A.

## TV-TST-001-P
- Vector ID: TV-TST-001-P
- Description: Full regression suite includes boundary tests for all fixed drop points.
- Input:
```json
{
  "testFiles": [
    "datafn/client/__tests__/search.test.ts",
    "datafn/client/__tests__/mutate.test.ts",
    "datafn/server/src/execution/query/__tests__/search.test.ts",
    "datafn/server/src/execution/search/__tests__/cross-resource.test.ts",
    "datafn/server/src/routes/__tests__/search.test.ts",
    "datafn/client/__tests__/plugins/clientSearch.test.ts"
  ]
}
```
- Expected output:
```json
{
  "coverage": "all updated boundaries asserted",
  "rcCoverage": ["RC-1", "RC-2", "RC-3", "RC-4", "RC-5", "RC-6", "RC-7", "RC-8"],
  "result": "pass"
}
```
- Negative variant(s): See TV-TST-001-N.

## TV-TST-001-N
- Vector ID: TV-TST-001-N
- Description: A boundary test is missing for option forwarding or lifecycle update.
- Input:
```json
{ "missingAssertion": "client.searchAll payload lacks prefix assertion" }
```
- Expected output:
```json
{ "gate": "fail", "message": "Boundary forwarding/lifecycle regression coverage incomplete" }
```
- Negative variant(s): N/A.

## TV-DOC-001-P
- Vector ID: TV-DOC-001-P
- Description: Search docs describe provider-backed local-first behavior and new options.
- Input:
```json
{ "docFile": "datafn/docs/content/docs/dfql/search.mdx" }
```
- Expected output:
```json
{
  "contains": [
    "prefix",
    "fuzzy",
    "fieldBoosts",
    "local-first",
    "source: auto|local|remote",
    "MiniSearch legacy mode deprecated"
  ]
}
```
- Negative variant(s): See TV-DOC-001-N.

## TV-DOC-001-N
- Vector ID: TV-DOC-001-N
- Description: Docs still claim MiniSearch-only client search as the primary path.
- Input:
```json
{ "docSnippet": "clientSearch plugin uses miniSearch for client search" }
```
- Expected output:
```json
{ "gate": "fail", "message": "Documentation not aligned with provider-backed architecture" }
```
- Negative variant(s): N/A.
