# Phase goal

Implement the core runtime context model, browser facade, capability registry, and error model.

# In scope / Out of scope

- In scope:
  - `getRuntime()`
  - runtime address metadata
  - Promise-first browser facade
  - raw browser passthrough
  - target capability registry
- Out of scope:
  - request routing
  - event bus
  - DataFn integration

# Deliverables

- Create `extfn/core/src/runtime/context.ts`
- Create `extfn/core/src/runtime/browser.ts`
- Create `extfn/core/src/runtime/capabilities.ts`
- Create `extfn/core/src/runtime/getRuntime.ts`
- Create `extfn/core/__tests__/runtime-context.test.ts`
- Create `extfn/core/__tests__/browser-facade.test.ts`

# Requirements covered

- `CTX-001`
- `CTX-002`
- `CTX-003`
- `SEC-001`

# Implementation tasks

- Implement context detection for `background`, `popup`, `options`, `sidepanel`, and `content`.
- Populate `RuntimeAddress` with `contentScriptId`, `tabId`, and `frameId` when available.
- Implement `browser.raw`, `browser.call()`, and `browser.namespace()`.
- Normalize callback-style Chrome APIs into Promise-returning calls.
- Publish a capability map for each supported target.
- Enforce unsupported method path failures against the active target.

# Verification steps

- Run `npm run test -- --filter=@superfunctions/extfn`
- Expected outcomes:
  - runtime address fixtures resolve correctly
  - callback-style browser methods are awaited through the facade
  - Firefox capability fixtures show unsupported sidepanel behavior

# Stop condition

Stop after the runtime can correctly identify executing context and browser facade tests pass for both Chromium and Firefox fixtures.
