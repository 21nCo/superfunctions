# Sub-spec: Framework Adapters

## Purpose

Define how shared `@uifn/core` behavior is exposed through React, Svelte, Vue, Solid, and Angular without forcing one framework's composition model onto another.

## Shared Contract

Every adapter MUST preserve:

- behavior state transitions,
- action semantics,
- part names,
- ARIA attributes,
- data attributes,
- keyboard behavior,
- disabled behavior,
- focus and scroll behavior,
- portal and positioning intent,
- controlled/uncontrolled semantics,
- conformance test results.

Every adapter MAY vary:

- component syntax,
- binding syntax,
- slot/snippet model,
- directive/action model,
- reactive primitive type,
- file extension and build pipeline.

## Adapter Kit Required Utilities

`@uifn/adapter-kit` MUST expose:

- `mergeProps`
- `mergeEventHandlers`
- `composeRefs`
- `createElementRegistry`
- `createLifecycleScope`
- `createFocusBridge`
- `createPortalBridge`
- `normalizeDataAttributes`
- `runAdapterConformance`
- `createSSRGuard`

## React API

React MUST expose:

```ts
useDialog(options)
Dialog.Root
Dialog.Trigger
Dialog.Portal
Dialog.Overlay
Dialog.Content
Dialog.Title
Dialog.Description
Dialog.Close
```

React components SHOULD support `asChild` when the rendered element may be delegated safely.

React tests MUST cover:

- controlled and uncontrolled props,
- Strict Mode double invocation,
- SSR/hydration ids,
- portal mounting,
- event composition,
- ref composition,
- keyboard navigation.

## Svelte API

Svelte MUST expose:

- component roots and parts,
- actions for headless attachment,
- snippet/slot APIs where appropriate,
- context errors for invalid part usage.

Svelte tests MUST cover:

- Svelte 5 compatibility,
- action cleanup,
- SSR/hydration ids,
- controlled value updates,
- slot/snippet rendering.

## Vue API

Vue MUST expose:

- `useX` composables,
- root/part components,
- provide/inject context,
- scoped slots where useful,
- typed props and emits.

Vue tests MUST cover:

- composable/component parity,
- provide/inject failures,
- SSR/hydration,
- v-model bindings,
- keyboard navigation.

## Solid API

Solid MUST expose:

- `createX` headless signal APIs,
- JSX root/part components,
- context helpers,
- callable prop getters.

Solid tests MUST cover:

- signal freshness,
- disposal cleanup,
- SSR rendering,
- event handler merging,
- reactive prop updates.

## Angular API

Angular MUST expose standalone directives first:

```html
<uifn-dialog [(open)]="open">
  <button uifnDialogTrigger>Open</button>
  <section uifnDialogContent>...</section>
</uifn-dialog>
```

Angular MUST also provide component wrappers for common usage.

Angular tests MUST cover:

- standalone import use,
- two-way binding,
- directive context discovery,
- outputs,
- keyboard navigation,
- server rendering where supported by the local Angular test setup.

## Conformance Harness

The conformance harness MUST run a primitive vector against every adapter and compare normalized output:

```json
{
  "primitive": "tabs",
  "eventTrace": ["focus:first-trigger", "key:ArrowRight", "key:Enter"],
  "expectedState": { "value": "second" },
  "expectedData": { "trigger.second": { "state": "active" } }
}
```

Adapters fail when normalized results diverge.
