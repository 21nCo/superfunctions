# PHASE_05

- Phase goal: Implement canonical OpenAPI ingestion and reference rendering so API specs become first-class docsfn content instead of an unsupported side path.

## In scope

- JSON and YAML OpenAPI loading from local or remote-ready provider inputs.
- Canonical API reference normalization.
- API reference page routing and manifest integration.
- React and Svelte API reference renderer parity.

## Out of scope

- Blog and embedded content behavior.
- Framework example-site adoption beyond API route validation.
- Private API access control beyond the shared auth model.

## Deliverables

- Create `docsfn/core/src/openapi.ts`.
- Create `docsfn/core/src/openapi.test.ts`.
- Modify `docsfn/core/src/manifest.ts`.
- Modify `docsfn/react/src/ApiReferenceRenderer.tsx`.
- Modify `docsfn/svelte/src/ApiReferenceRenderer.svelte`.
- Create `docsfn/react/src/ApiReferenceRenderer.test.tsx`.
- Create `docsfn/svelte/src/ApiReferenceRenderer.test.ts`.

## Requirements covered

- `API-001`
- `API-002`
- `PAGE-001`
- `DET-001`

## Implementation tasks

1. Define canonical API reference records that normalize operations, tags, schemas, servers, and examples from OpenAPI `3.x` inputs.
2. Support both JSON and YAML inputs and preserve remote-ready provider fields so later remote provider work does not require API model changes.
3. Integrate API pages into the manifest and navigation pipeline with route semantics that mirror docs routes and remain searchable.
4. Update React and Svelte API renderers to consume the canonical API model rather than raw OpenAPI blobs.
5. Add validation diagnostics for unsupported spec versions, malformed path operations, and duplicate operation IDs.
6. Add tests that cover tag grouping, schema rendering, parameter tables, example payloads, and route derivation from OpenAPI sources.
7. Add negative tests that assert fail-closed behavior on invalid or partially unreadable API specs.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/core run test -- --run src/openapi.test.ts src/manifest.test.ts`
   Expected outcome: OpenAPI normalization and API route integration tests pass.
2. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/react run build`
   Expected outcome: the React API renderer builds against the canonical API model.
3. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/svelte run build`
   Expected outcome: the Svelte API renderer builds against the canonical API model and its type declarations remain valid.
4. Manual check: render one fixture API reference page in both framework renderers.
   Expected outcome: operations, parameters, schemas, and examples appear in the same canonical order in both frameworks.

## Stop condition

- Report the supported OpenAPI input formats and versions.
- Report the manifest representation of API pages and how they join navigation and search.
- Report any unsupported OpenAPI constructs that still emit non-fatal diagnostics.
