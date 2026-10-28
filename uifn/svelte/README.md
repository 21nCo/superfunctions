# @uifn/svelte

Catalog-complete, permanently headless Svelte 5 compounds for uifn. The package exposes all 69 stable primitives and all 465 catalog anatomy parts as concrete typed Svelte components.

This package never ships visual CSS, tokens, themes, or component styling. Use
it to build a design system; use `@uifn/components-svelte` plus
`@uifn/components/styles.css` for the maintained styled compounds.

The components are adapters over `@uifn/core` controllers and static contracts. Browser behavior—focus, layers, portals, positioning, gestures, native form reset, and presence—remains owned by `@uifn/dom`. Components do not contain a second framework-local state machine.

## Install

```bash
npm install @uifn/svelte @uifn/core @uifn/dom @uifn/adapter-kit svelte
```

Svelte `>=5.20 <6` and Node `20` through `24` are supported.

## Compound API

Import the complete package or a tree-shakeable primitive subpath:

```svelte
<script lang="ts">
  import { Accordion } from '@uifn/svelte/accordion';

  let value = $state<string | string[]>([]);
</script>

<Accordion.Root type="multiple" bind:value>
  <Accordion.Item value="billing">
    <Accordion.Header value="billing">
      <Accordion.Trigger value="billing">Billing</Accordion.Trigger>
    </Accordion.Header>
    <Accordion.Content value="billing">Billing details</Accordion.Content>
  </Accordion.Item>
</Accordion.Root>
```

Every catalog part is also a named export, such as `AccordionRoot` and `AccordionTrigger`. Parts whose anatomy cardinality is `many` require a typed `value` that identifies the corresponding core part.

## Svelte 5 contracts

- Root inputs are reactive and update the existing controller through `controller.update`; prop changes do not recreate the behavior service.
- Controlled values are bindable where the catalog defines them: `bind:value`, `bind:open`, `bind:checked`, and the corresponding primitive-specific bindings.
- Every component supports `bind:ref`, a `children` snippet, and a typed `render` snippet.
- A render snippet receives merged props, the Svelte action and its parameters, the current state/actions/status, and the bridge. Apply the supplied action when replacing the default element.
- User event callbacks run before internal behavior. `event.preventDefault()` cancels cancelable internal behavior while protected accessibility invariants remain intact.
- Components use `$props.id()` plus the injected environment to keep IDs stable across SSR and hydration.

## SSR and packaging

The npm package exports only `dist` entries. JavaScript helpers and declarations are compiled, component sources are preprocessed by the standard Svelte library packager, and no repository TypeScript path is an npm entrypoint.

SSR renders deterministic semantic HTML. Hydration activates the live controller and DOM services once, preserves server IDs, and synchronously tears down controller subscriptions, actions, portals, and DOM leases on unmount.

## Forms and portals

Render the catalog's `HiddenInput` parts for form primitives. Checkbox and radio families use native checked controls; other value families serialize through hidden inputs. Form reset is delegated to the shared DOM platform.

Portal parts render in place during SSR and move through `@uifn/dom` after mount. Pass `container` to target an element, shadow root, selector, or target function.

## Workbench

The Svelte Workbench app is `@uifn/example-svelte-workbench` under `uifn/examples/svelte-workbench`.

```bash
npm --workspace @uifn/examples run dev:svelte
npm run verify:uifn-browser -- --framework svelte
```

## Verification

Run these from the repository root.

```bash
npm --workspace @uifn/svelte run typecheck
npm --workspace @uifn/svelte run test
npm --workspace @uifn/svelte run build
npm --workspace @uifn/dom run test:browser -- --project=chromium --project=firefox --project=webkit browser/adapters
npm run verify:uifn-phase-12
npm run verify:uifn-stable
```

- `typecheck` runs `svelte-check` over the package.
- `test` runs the Vitest suites in `tests/` under jsdom, not a real browser. They render all 69 catalog compound roots, drive core behavior through compound parts and `bind:value`, update controller inputs without recreating the live service, and check DOM-owned portals, native form participation, and Menubar focus movement and restoration. They also mount, operate, and clean up every catalog public tree, and cover part-action reconciliation and hook cleanup.
- `build` packages `lib/` into `dist/` with `svelte-package`.
- `test:browser … browser/adapters` mounts the built package's Svelte fixtures in Chromium, Firefox, and WebKit. At present that is Tabs arrow-key, Home, and End navigation with wraparound, pointer selection, and a clean unmount. The `uifn browser tests` CI workflow runs the full `@uifn/dom` browser suite in these three engines on every pull request that changes `uifn/**`.
- `verify:uifn-phase-12` runs `typecheck`, `test`, and `build`, then the generated-inventory and negative mutation-code contract (`scripts/verify-uifn-phase-12-contract.mjs`). It also builds an Accordion consumer from source and from the packed tarballs, renders it on the server, and hydrates it in Chromium, Firefox, and WebKit with matching IDs and no console diagnostics (`scripts/verify-uifn-svelte-consumer.mjs`). Finally it checks the packed contents (`scripts/verify-uifn-pack.mjs`).
- `verify:uifn-stable` runs the Svelte `typecheck`, `test` (and reports its test count), and `build`, along with the other stable packages and the `@uifn/dom` browser suite.
