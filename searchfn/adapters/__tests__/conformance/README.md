# SearchAdapter Conformance Suite

Every `SearchAdapter` implementation MUST pass the shared conformance test suite defined in `shared.ts`.

## How to add a new adapter

1. Create `<adapter-name>.conformance.test.ts` in this directory.
2. Import `runConformanceSuite` from `./shared`.
3. Provide a factory that creates a fresh adapter instance per test.
4. Set `persistent: true/false` based on whether data survives dispose+reinitialize.

```ts
import { describe } from "vitest";
import { MyAdapter } from "../../src/my-adapter";
import { runConformanceSuite } from "./shared";

describe("MyAdapter conformance", () => {
  runConformanceSuite({
    name: "my-adapter",
    create: () => new MyAdapter(/* config */),
    persistent: false,
    cleanup: async () => { /* optional teardown */ },
  });
});
```

## Running

```bash
npm --prefix searchfn/adapters test -- __tests__/conformance/*.test.ts
```

## Assertions covered

- **contract-shape**: `name`, required methods (`index`, `search`, `remove`, `clear`), optional `capabilities`
- **index-search**: basic indexing, query matching, upsert semantics, limit enforcement
- **deterministic-ordering**: consistent tie-breaking across repeated searches
- **remove**: by id, idempotent removal
- **clear**: per-resource clear, cross-resource isolation
- **searchAll**: merged cross-resource results with deterministic global ordering
- **lifecycle**: dispose blocks operations, reinitialize restores functionality

## External adapters

Postgres, Meilisearch, and Elasticsearch/OpenSearch conformance tests require running backends.
These tests may use Docker-backed environments and are typically run in CI or with local containers.
