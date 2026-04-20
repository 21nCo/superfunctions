# Phase goal

Add the first-party Svelte 5 adapter and create framework validation examples for both Svelte and vanilla authoring.

# In scope / Out of scope

- In scope:
  - Svelte 5 page mount helper
  - Svelte 5 content mount helper
  - vanilla example extension
  - Svelte multi-content example extension
- Out of scope:
  - DataFn integration

# Deliverables

- Create `extfn/svelte/src/index.ts`
- Create `extfn/svelte/src/page.ts`
- Create `extfn/svelte/src/content.ts`
- Create `extfn/svelte/__tests__/mounts.test.ts`
- Create `extfn/examples/vanilla-messaging-demo/extfn.config.ts`
- Create `extfn/examples/vanilla-messaging-demo/vite.config.ts`
- Create `extfn/examples/vanilla-messaging-demo/src/background/index.ts`
- Create `extfn/examples/vanilla-messaging-demo/src/popup.html`
- Create `extfn/examples/vanilla-messaging-demo/src/popup.ts`
- Create `extfn/examples/svelte-multi-content-demo/extfn.config.ts`
- Create `extfn/examples/svelte-multi-content-demo/vite.config.ts`
- Create `extfn/examples/svelte-multi-content-demo/svelte.config.js`
- Create `extfn/examples/svelte-multi-content-demo/src/background/index.ts`
- Create `extfn/examples/svelte-multi-content-demo/src/contents/*.ts`
- Create `extfn/examples/svelte-multi-content-demo/src/contents/*.svelte`
- Create `extfn/examples/svelte-multi-content-demo/src/popup/*`

# Requirements covered

- `FWK-001`
- `FWK-002`
- `CNT-001`
- `CNT-002`
- `EX-001`

# Implementation tasks

- Wire `@sveltejs/vite-plugin-svelte` into the Svelte example and adapter package.
- Implement `mountSveltePage()` for popup/options/sidepanel pages.
- Implement `mountSvelteContent()` for content-script targets and shadow-root mounts.
- Build the vanilla example to validate raw runtime and browser facade usage.
- Build the Svelte example to validate anchored content modules and modular handlers.
- Keep all framework-specific code out of `extfn/core` and `extfn/vite`.

# Verification steps

- Run `npm run build -- --filter=vanilla-messaging-demo`
- Run `npm run build -- --filter=svelte-multi-content-demo`
- Run `npm run test -- --filter=@superfunctions/extfn-svelte`
- Expected outcomes:
  - vanilla example builds without Svelte dependency in core packages
  - Svelte example mounts popup and content surfaces
  - multi-content example emits at least two content module entries

# Stop condition

Stop after both example extensions build successfully and the Svelte adapter tests pass.
