# Phase goal

Implement multiple isolated content modules, anchored mounts, style isolation, and idempotent reinjection behavior.

# In scope / Out of scope

- In scope:
  - content module registration
  - anchor strategies
  - content style isolation and root normalization
  - deterministic mount identity
  - DOM observer and reinjection behavior
- Out of scope:
  - Svelte-specific mount helpers
  - DataFn integration

# Deliverables

- Create `extfn/core/src/content/contentScript.ts`
- Create `extfn/core/src/content/anchors.ts`
- Create `extfn/core/src/content/mountRegistry.ts`
- Create `extfn/core/src/content/reinject.ts`
- Create `extfn/core/__tests__/content-anchors.test.ts`
- Create `extfn/core/__tests__/content-reinject.test.ts`
- Create fixture modules under `extfn/core/__tests__/fixtures/content/`

# Requirements covered

- `CNT-001`
- `CNT-002`
- `CNT-003`
- `CNT-004`

# Implementation tasks

- Implement `defineContentScript()` validation and runtime shape.
- Support selector, selector-list, and resolver anchor strategies.
- Implement `inherit`, `root-scoped`, and `shadow-root` style isolation modes.
- Implement deterministic root normalization for opted-in content mounts.
- Create deterministic root IDs using content module ID and anchor identity.
- Add a mount registry to prevent duplicate mounts on SPA transitions.
- Implement remount/reinject support when host DOM nodes are replaced.
- Ensure style attachment is idempotent across initial mount and reinjection.
- Ensure anchor-resolution failures are isolated and logged.

# Verification steps

- Run `npm run test -- --filter=@superfunctions/extfn`
- Expected outcomes:
  - multiple content modules can target the same URL fixture without collisions
  - anchor list and resolver strategies mount correctly
  - style isolation fixtures prove host-page typography does not silently distort injected UI when normalization is enabled
  - reinjection remains idempotent across repeated navigation fixtures

# Stop condition

Stop after clipper-like content module fixtures cover many isolated entries, anchored remounts, and deterministic style isolation without duplicate roots.
