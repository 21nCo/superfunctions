# PHASE_02

- Phase goal: Restore React and Next rendering parity for canonical fixtures and shipped surfaces.

## In scope

- React `DocsContent`
- React blog and embedded render usage
- Next proof-route integration

## Out of scope

- Svelte package/export changes
- docs site documentation updates
- release-gate finalization

## Deliverables

- Modify `docsfn/react/src/DocsContent.tsx`
- Create `docsfn/react/src/DocsContent.test.tsx`
- Create or expand React tests for blog and embedded rendering
- Modify Next example and/or helpers required for proof routes

## Requirements covered

- `REACT-001`
- `BLOG-001`
- `EMBED-001`
- `TEST-001`

## Implementation tasks

1. Render tabs recursively from compiled child nodes.
2. Render Mermaid through an explicit renderer contract rather than raw `<pre>`.
3. Fail closed on unresolved component mappings.
4. Ensure blog and embedded proof surfaces use shipped components.
5. Add React DOM assertions for tabs, mermaid, custom components, and no raw-source fallback.

## Verification steps

1. Run: `npm --prefix docsfn/react run test -- --run`
   Expected outcome: React parity tests pass, including no raw-source fallback assertions.
2. Run the Next proof-route tests/build against both canonical fixtures.
   Expected outcome: proof routes render shipped components for docs/api/blog/embedded surfaces.

## Stop condition

- Report the React proof routes and the DOM assertions that guarantee parity.
