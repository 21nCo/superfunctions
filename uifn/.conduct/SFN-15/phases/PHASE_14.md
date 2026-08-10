# PHASE_14: Hooks

## Phase Goal

Implement framework equivalents for `useMediaQuery` and `useCopyToClipboard`.

## In Scope

- React hooks.
- Svelte helpers/actions.
- Vue composables.
- Solid helpers.
- Angular services/directives.
- SSR-safe behavior.
- Cleanup tests.

## Out of Scope

- Additional hooks not in the Coss target snapshot.

## Deliverables

- `uifn/*/src/use-media-query*`
- `uifn/*/src/use-copy-to-clipboard*`
- hook manifests and registry items
- hook stories/docs

## Requirements Covered

HOOK-001, REG-001, DOCS-001

## Implementation Tasks

1. Define shared media query behavior and SSR fallback.
2. Define shared clipboard success/failure result shape.
3. Implement equivalents in every framework.
4. Add cleanup tests.
5. Add docs and registry entries.

## Verification Steps

```bash
npm run verify:uifn-hooks
```

Expected outcome: hooks pass SSR, cleanup, and failure behavior tests for every framework.

## Stop Condition

Report exact hook/composable/service names per framework.

