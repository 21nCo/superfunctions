# TEST VECTORS

---

## TV-CTR-001 — SearchParams accepts prefix field

- **Description**: SearchParams with prefix compiles and is accepted by adapter.
- **Input**: `{ resource: "todos", query: "to", prefix: true, limit: 10 }`
- **Expected**: TypeScript compiles. Adapter receives the param.
- **Negative**: `{ resource: "todos", query: "to", prefix: "yes" }` — type error at compile time.

---

## TV-CTR-002 — SearchParams without prefix is backward compatible

- **Description**: Existing code that omits prefix continues to compile and work.
- **Input**: `{ resource: "todos", query: "todo", limit: 10 }`
- **Expected**: Compiles. Adapter treats prefix as `false`/off.

---

## TV-CTR-003 — SearchAllParams accepts prefix field

- **Description**: SearchAllParams with prefix compiles and is accepted.
- **Input**: `{ query: "to", resources: ["todos", "categories"], prefix: true, limit: 20 }`
- **Expected**: TypeScript compiles. Adapter receives the param.

---

## TV-CTR-004 — SearchAllParams without prefix is backward compatible

- **Description**: Existing code that omits prefix continues to work.
- **Input**: `{ query: "todo", resources: ["todos"], limit: 10 }`
- **Expected**: Compiles. Prefix treated as off.

---

## TV-CAP-001 — Capabilities advertise prefix

- **Description**: Adapter capabilities include prefix field.
- **Input**: `adapter.capabilities`
- **Expected (ES/OS/Memory/IDB/PG/Meili)**: `{ ..., prefix: true }`
- **Negative**: An adapter that does not implement prefix MUST NOT set `prefix: true`.

---

## TV-ES-001 — Elasticsearch prefix: true matches partial terms

- **Description**: With prefix enabled, a partial query matches full terms.
- **Input**: Index document `{ id: "1", fields: { text: "todo item" } }` in resource "todos". Search: `{ resource: "todos", query: "to", prefix: true, limit: 10 }`.
- **Expected**: Returns `["1"]` (or `[1]`).
- **Negative**: Same search with `prefix: false` → returns `[]` (no match on partial term).

---

## TV-ES-002 — Elasticsearch prefix query structure

- **Description**: When prefix is true, the ES query uses bool.should with phrase_prefix.
- **Input**: `search({ resource: "todos", query: "to", prefix: true })`
- **Expected query body**:
  ```json
  {
    "query": {
      "bool": {
        "should": [
          { "multi_match": { "query": "to", "fields": ["*"] } },
          { "multi_match": { "query": "to", "fields": ["*"], "type": "phrase_prefix" } }
        ],
        "minimum_should_match": 1
      }
    }
  }
  ```

---

## TV-ES-003 — Elasticsearch prefix: false uses original query

- **Description**: When prefix is false/omitted, the query is a single multi_match (unchanged).
- **Input**: `search({ resource: "todos", query: "todo" })`
- **Expected query body**:
  ```json
  {
    "query": {
      "multi_match": { "query": "todo", "fields": ["*"] }
    }
  }
  ```

---

## TV-ES-004 — Elasticsearch prefix + fuzzy combined

- **Description**: Both prefix and fuzzy produce three should clauses.
- **Input**: `search({ resource: "todos", query: "to", prefix: true, fuzzy: true })`
- **Expected query body**:
  ```json
  {
    "query": {
      "bool": {
        "should": [
          { "multi_match": { "query": "to", "fields": ["*"] } },
          { "multi_match": { "query": "to", "fields": ["*"], "type": "phrase_prefix" } },
          { "multi_match": { "query": "to", "fields": ["*"], "fuzziness": "AUTO" } }
        ],
        "minimum_should_match": 1
      }
    }
  }
  ```

---

## TV-ES-005 — Elasticsearch construct-time defaults applied

- **Description**: Adapter defaults are used when query params omit options.
- **Input**: Construct with `defaults: { prefix: true, fuzzy: true }`. Search: `{ resource: "todos", query: "to" }` (no prefix/fuzzy in params).
- **Expected**: Query uses both phrase_prefix and fuzziness (as if both were passed).

---

## TV-ES-006 — Query-time overrides construct-time default

- **Description**: Query param takes precedence over default.
- **Input**: Construct with `defaults: { prefix: true }`. Search: `{ resource: "todos", query: "todo", prefix: false }`.
- **Expected**: Query is a single `multi_match` (no phrase_prefix clause). Prefix default is overridden.

---

## TV-MEM-001 — Memory adapter prefix: true matches partial terms

- **Description**: With prefix enabled, partial query matches indexed terms.
- **Input**: Index `{ id: "1", fields: { text: "testing" } }`. Search: `{ resource: "r", query: "test", prefix: true }`.
- **Expected**: Returns `["1"]` (or `[1]`).
- **Negative**: `prefix: false` with query "test" may or may not match depending on stemming; with stemming disabled and no prefix, exact token "test" does not match "testing".

---

## TV-MEM-002 — Memory adapter prefix: false is unchanged behavior

- **Description**: Without prefix, behavior is identical to current.
- **Input**: Index `{ id: "1", fields: { text: "hello world" } }`. Search: `{ resource: "r", query: "hel" }`.
- **Expected**: Returns `[]` (no match — prefix tokens filtered out, which is current behavior).

---

## TV-MEM-003 — Memory adapter construct-time defaults

- **Description**: Defaults from SearchAdapterConfig are applied.
- **Input**: Construct `new MemoryAdapter({ defaults: { prefix: true } })`. Index and search with `{ resource: "r", query: "hel" }`.
- **Expected**: Returns match (prefix default applied).

---

## TV-IDB-001 — IndexedDB adapter prefix matching

- **Description**: Same as TV-MEM-001 but for IndexedDB adapter.
- **Input**: Same as TV-MEM-001.
- **Expected**: Same as TV-MEM-001.

---

## TV-IDB-002 — IndexedDB adapter construct-time defaults

- **Description**: Same as TV-MEM-003 but for IndexedDB adapter.
- **Input**: Construct with `{ defaults: { prefix: true } }`. Search partial term.
- **Expected**: Match found via prefix default.

---

## TV-PG-001 — Postgres adapter prefix: true uses :* operator

- **Description**: With prefix enabled, Postgres tsquery uses prefix operator.
- **Input**: Index `{ id: "1", fields: { text: "testing" } }`. Search: `{ resource: "r", query: "test", prefix: true }`.
- **Expected**: Returns `["1"]` (or `[1]`). Generated tsquery uses `test:*`.
- **Negative**: `prefix: false` with "test" returns `["1"]` only if "test" is an exact lexeme.

---

## TV-PG-002 — Postgres prefix + fuzzy both use :*

- **Description**: Both prefix and fuzzy trigger the same `:*` mechanism in Postgres.
- **Input**: `{ resource: "r", query: "test", prefix: true, fuzzy: true }`
- **Expected**: Same result as prefix alone (no duplication of `:*`).

---

## TV-PG-003 — Postgres adapter construct-time defaults

- **Description**: Defaults from options are applied.
- **Input**: Construct with `{ defaults: { prefix: true } }`. Search partial term without prefix param.
- **Expected**: Match found via prefix default.

---

## TV-MS-001 — Meilisearch capabilities include prefix

- **Description**: Meilisearch adapter advertises prefix capability.
- **Input**: `adapter.capabilities`
- **Expected**: `{ ..., prefix: true }`

---

## TV-MS-002 — Meilisearch adapter accepts defaults without error

- **Description**: Construct with defaults; no error.
- **Input**: `new MeilisearchAdapter({ host: "...", defaults: { prefix: true, fuzzy: true } })`
- **Expected**: Adapter constructed successfully. Options do not cause errors.

---

## TV-CLT-001 — Client resolves prefix from defaults

- **Description**: Client applies prefix default when query param omits it.
- **Input**: `createSearchClient({ adapter, defaults: { prefix: true } })`. Call `search({ resource: "r", query: "to" })`.
- **Expected**: Adapter's `search()` is called with `prefix: true`.

---

## TV-CLT-002 — Client query-time prefix overrides default

- **Description**: Client passes query-time prefix to adapter, overriding default.
- **Input**: `createSearchClient({ adapter, defaults: { prefix: true } })`. Call `search({ resource: "r", query: "to", prefix: false })`.
- **Expected**: Adapter's `search()` is called with `prefix: false`.

---

## TV-SRV-001 — Server search route passes prefix

- **Description**: Server passes prefix from request body to adapter.
- **Input**: POST `/search` with body `{ resource: "todos", query: "to", prefix: true }`.
- **Expected**: Adapter's `search()` receives `prefix: true`.

---

## TV-SRV-002 — Server searchAll route passes prefix

- **Description**: Server passes prefix from request body to adapter.searchAll.
- **Input**: POST `/search-all` with body `{ query: "to", resources: ["todos"], prefix: true }`.
- **Expected**: Adapter's `searchAll()` receives `prefix: true`.

---

## TV-DFP-001 — DataFn-provider forwards fuzzy, prefix, fieldBoosts to search

- **Description**: Provider passes all search options to adapter.search.
- **Input**: Call provider's `search({ resource: "todos", query: "to", fuzzy: true, prefix: true, fieldBoosts: { text: 2 } })`.
- **Expected**: Adapter's `search()` receives all three params.
- **Negative**: Currently (before fix) adapter receives none of these.

---

## TV-DFP-002 — DataFn-provider forwards options to searchAll

- **Description**: Provider passes all search options to adapter.searchAll.
- **Input**: Call provider's `searchAll({ query: "to", resources: ["todos"], fuzzy: true, prefix: true })`.
- **Expected**: Adapter's `searchAll()` receives `fuzzy: true` and `prefix: true`.
