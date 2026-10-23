# ApiFn — Phased Implementation Plan

## Architecture Sketch

```
apifn/
├── .conduct/                      # Artifacts (spec, plans, audits)
├── core/                          # @apifn/core — route introspection, schema conversion, OpenAPI gen, diff
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts               # All shared types
│   │   ├── introspect.ts          # introspectRouter()
│   │   ├── schema/
│   │   │   ├── detect.ts          # Schema type detection
│   │   │   ├── zod.ts             # Zod → JSON Schema
│   │   │   ├── typebox.ts         # TypeBox cleanup
│   │   │   ├── convert.ts         # Unified converter
│   │   │   └── dedup.ts           # $ref deduplication
│   │   ├── openapi/
│   │   │   ├── generate.ts        # generateOpenAPI()
│   │   │   ├── parse.ts           # parseOpenAPI()
│   │   │   ├── validate.ts        # validateOpenAPI()
│   │   │   ├── upconvert.ts       # 3.0 → 3.1
│   │   │   └── from-router.ts     # fromRouter() convenience
│   │   └── diff/
│   │       ├── diff.ts            # diffOpenAPI()
│   │       ├── rules.ts           # Breaking/non-breaking rules
│   │       └── format.ts          # Output formatting
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsup.config.ts
│   └── vitest.config.ts
│
├── collections/                   # @apifn/collections — OpenCollection read/write/run
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── reader.ts              # readCollection()
│   │   ├── writer.ts              # writeCollection()
│   │   ├── validator.ts           # validateCollection()
│   │   ├── generator.ts           # openAPIToCollection(), routerToCollection()
│   │   ├── environment.ts         # Environment handling
│   │   ├── variables.ts           # Variable interpolation
│   │   ├── runner/
│   │   │   ├── runner.ts          # runCollection()
│   │   │   ├── http-client.ts     # Built-in fetch client
│   │   │   ├── script-sandbox.ts  # Script execution sandbox
│   │   │   ├── assertions.ts      # Assertion helpers
│   │   │   └── reporters/
│   │   │       ├── console.ts
│   │   │       ├── json.ts
│   │   │       └── silent.ts
│   │   └── report.ts              # RunReport generation
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsup.config.ts
│   └── vitest.config.ts
│
├── cli/                           # @apifn/cli — CLI tools
│   ├── src/
│   │   ├── index.ts
│   │   ├── config.ts              # Config loading, defineConfig()
│   │   ├── commands/
│   │   │   ├── init.ts
│   │   │   ├── generate.ts
│   │   │   ├── export.ts
│   │   │   ├── test.ts
│   │   │   ├── diff.ts
│   │   │   ├── serve.ts
│   │   │   ├── mock.ts
│   │   │   ├── snippet.ts
│   │   │   └── validate.ts
│   │   └── utils/
│   │       ├── router-loader.ts   # Load router from TS file
│   │       └── output.ts          # Console formatting
│   ├── package.json
│   └── tsconfig.json
│
├── snippets/                      # @apifn/snippets — Code snippet generation
│   ├── src/
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── targets/
│   │   │   ├── curl.ts
│   │   │   ├── fetch.ts
│   │   │   ├── axios.ts
│   │   │   ├── python-requests.ts
│   │   │   └── ...
│   │   └── generator.ts
│   ├── package.json
│   └── tsconfig.json
│
├── mock/                          # @apifn/mock — Mock server
│   ├── src/
│   │   ├── index.ts
│   │   ├── server.ts
│   │   ├── response-generator.ts
│   │   └── request-validator.ts
│   ├── package.json
│   └── tsconfig.json
│
├── react/                         # @apifn/react — React UI components
│   ├── src/
│   │   ├── index.ts
│   │   ├── ApiExplorer.tsx
│   │   ├── EndpointViewer.tsx
│   │   ├── SchemaViewer.tsx
│   │   ├── TryIt.tsx
│   │   ├── RequestHistory.tsx
│   │   ├── ResponseDiff.tsx
│   │   ├── PerformanceOverlay.tsx
│   │   └── styles/
│   ├── package.json
│   └── tsconfig.json
│
├── svelte/                        # @apifn/svelte — Svelte UI components
│   ├── src/
│   │   ├── index.ts
│   │   ├── ApiExplorer.svelte
│   │   ├── EndpointViewer.svelte
│   │   ├── SchemaViewer.svelte
│   │   ├── TryIt.svelte
│   │   ├── RequestHistory.svelte
│   │   ├── ResponseDiff.svelte
│   │   ├── PerformanceOverlay.svelte
│   │   └── styles/
│   ├── package.json
│   └── tsconfig.json
│
├── docsfn/                        # @apifn/docsfn — docsfn plugin
│   ├── src/
│   │   ├── index.ts
│   │   ├── provider.ts           # createApifnProvider()
│   │   ├── react/
│   │   │   └── ApifnApiReference.tsx
│   │   └── svelte/
│   │       └── ApifnApiReference.svelte
│   ├── package.json
│   └── tsconfig.json
│
├── python/                        # apifn — Python package
│   ├── apifn/
│   │   ├── __init__.py
│   │   ├── fastapi.py
│   │   ├── flask.py
│   │   ├── collections.py
│   │   ├── diff.py
│   │   └── openapi.py
│   ├── tests/
│   ├── pyproject.toml
│   └── README.md
│
└── examples/
    ├── basic/                     # Basic usage example
    ├── with-docsfn/               # docsfn integration example
    └── ci-cd/                     # CI/CD workflow example
```

## Dependency Graph

```
                    @apifn/core
                   /     |      \
                  /      |       \
    @apifn/collections  @apifn/snippets  @apifn/mock
         |               |
         |               |
     @apifn/cli ─────────┘
         |
    @apifn/react  @apifn/svelte
         |              |
    @apifn/docsfn ──────┘
```

External dependencies:
- `@apifn/core` → `@superfunctions/http` (peer), `zod` (peer, optional), `@sinclair/typebox` (peer, optional), `yaml`
- `@apifn/collections` → `@apifn/core`, `yaml`, `glob`
- `@apifn/cli` → `@apifn/core`, `@apifn/collections`, `@apifn/snippets`, `@apifn/mock`, `cac`, `picocolors`, `chokidar`
- `@apifn/snippets` → `@apifn/core`
- `@apifn/mock` → `@apifn/core`, `@superfunctions/http`
- `@apifn/react` → `@apifn/core`, `react` (peer), `@uifn/react` (peer, optional)
- `@apifn/svelte` → `@apifn/core`, `svelte` (peer), `@uifn/svelte` (peer, optional)
- `@apifn/docsfn` → `@apifn/core`, `@apifn/react`, `@apifn/svelte`, `docsfn` (peer)

Build order: core → (collections, snippets, mock) → cli → (react, svelte) → docsfn

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|-------|------|---------------------|--------------|
| 00 | Project scaffolding | All packages scaffold with build/test infra | `npm run build` succeeds in all packages |
| 01 | Core types | All shared types exported from @apifn/core | TypeScript compilation, type import tests |
| 02 | Route introspection | Extract routes from @superfunctions/http Router | Unit tests: route extraction, path conversion, filtering |
| 03 | Schema conversion | Zod/TypeBox/JSON Schema → JSON Schema | Unit tests: conversion for all schema types |
| 04 | OpenAPI generation | Generate valid OpenAPI 3.1 from introspected routes | Validation against OpenAPI 3.1 JSON Schema |
| 05 | OpenAPI import & validation | Parse/validate existing OpenAPI docs | Unit tests: JSON/YAML parsing, 3.0→3.1 upconversion |
| 06 | OpenCollection read/write | Read and write OpenCollection YAML collections | Unit tests: round-trip read/write, Bruno fixture compat |
| 07 | Collection generation | Generate OpenCollection from OpenAPI/Router | Unit tests: generated collections validate and match expected structure |
| 08 | Environment management | Variable interpolation and environment handling | Unit tests: precedence, secrets, interpolation |
| 09 | CLI foundation | `apifn init`, `generate`, `export`, `validate` commands | CLI integration tests |
| 10 | HTTP client & collection runner | Execute collections against live/mock APIs | Unit tests: sequential/parallel execution, timeouts |
| 11 | Test assertions & scripts | Assertion helpers and script sandbox | Unit tests: all assertion types, script execution |
| 12 | CLI test command | `apifn test` with reporters | CLI integration test: run collection, check exit codes |
| 13 | Breaking change detection | `diffOpenAPI()` with breaking/non-breaking classification | Unit tests: all diff rules from SPEC Section 7.5 |
| 14 | CLI diff command | `apifn diff` for CI/CD | CLI integration test: diff two specs, check exit codes |
| 15 | Code snippet generation | Generate code snippets for all targets | Unit tests: curl, fetch, python-requests, etc. |
| 16 | Mock server | Schema/example/random response generation | Integration tests: serve spec, send requests, validate responses |
| 17 | CLI serve & mock commands | `apifn serve` and `apifn mock` | Manual + integration: start servers, verify responses |
| 18 | React UI components | ApiExplorer, EndpointViewer, SchemaViewer, TryIt | Component render tests, visual inspection |
| 19 | Svelte UI components | Same components for Svelte | Component render tests, visual inspection |
| 20 | docsfn plugin | Content provider + API reference renderers | Integration test: build docsfn manifest with apifn provider |
| 21 | watchfn integration | Fetch metrics, PerformanceOverlay, middleware | Integration tests against watchfn (or mock) |
| 22 | authfn + secfn + logfn integration | Test tokens, rate limits, structured logging | Unit tests for each integration |
| 23 | testfn adapter | ApifnTestAdapter for testfn | Unit test: discover + run collections via testfn |
| 24 | Python package | FastAPI/Flask adapters, collection runner, diff | pytest: introspection, runner, diff |
| 25 | CI/CD integration | GitHub Actions workflow, PR comments | Workflow file validation, manual test |

## Definition of Done (Global)

No phase is complete unless:
1. All verification steps for that phase pass.
2. All new code has corresponding tests with ≥80% line coverage for the new files.
3. `npm run build` succeeds for all affected packages.
4. `npm run test` passes for all affected packages.
5. No TypeScript compilation errors.
6. A phase report is written to `phase-reports/PHASE_XX-{date}-{id}-report.md`.
7. The phase's requirements from REQUIREMENTS.md are satisfied (acceptance criteria checked off).
