# Component catalog findings — 2026-07-16

## Scope

The catalog verification exercised the actual uifn framework packages inside
Next.js, SvelteKit, Nuxt, SolidStart, and Angular applications. Each framework
was checked at representative component, component QA, hook, pattern, and
superfunction-panel routes.

Evidence:

- `uifn/.conduct/evidence/catalog-sites-production-settled/verification.json`
- `uifn/.conduct/evidence/catalog-sites-production-settled/angular-button.png`

## UIFN-CATALOG-001 — Angular components do not render their styled root contract

- Severity: High
- Status: Open
- Framework: Angular
- Confirmed route: `/components/angular/components/button`
- Also affects: generated Batch A, Batch B, and data-rich Angular components

### Observed behavior

The actual Angular component class is instantiated successfully and its
`uifn-*` host is present, but the rendered DOM contains no element with
`data-uifn-component`. The same absence is visible on the Accordion QA route.

The automated evidence records one Angular component host and zero uifn
component roots:

```json
{
  "code": "UIFN_CATALOG_COMPONENT_ROOT_MISSING",
  "framework": "angular",
  "route": "/components/angular/components/button",
  "evidence": {
    "angularHostCount": 1
  }
}
```

### Expected behavior

Rendering an Angular uifn component should materialize the root element
described by `renderedRoot`, including:

- the component's semantic/default tag;
- `data-uifn-component` and `data-uifn-part="root"`;
- recipe class names and CSS variables;
- state and accessibility attributes;
- rendered anatomy parts and their interaction wiring.

This should match the observable DOM contract already rendered by the React,
Svelte, Vue, and Solid packages.

### Root cause

The Angular runtime classes calculate the complete DOM representation in
`renderedRoot`, but the generated Angular component metadata uses only:

```ts
template: '<ng-content></ng-content>'
```

No template or host binding consumes `renderedRoot`. Consequently, Angular
projects content into an otherwise empty custom-element host while the
calculated tag, attributes, styles, anatomy, and state remain a TypeScript DTO.

Relevant implementation:

- `uifn/components/src/angular/rendering.ts`
  - `UifnAngularStyledComponent.renderedRoot`
  - `createAngularBatchAComponent`
  - `createAngularBatchBComponent`
  - `createAngularDataRichComponent`

### Impact

- Angular consumers do not receive the documented DOM and styling contract.
- Recipe styling, state attributes, and component anatomy are not rendered.
- Accessibility and interactive behavior encoded in `renderedRoot` are absent.
- Visual and behavior parity with the other framework packages cannot be
  evaluated until the Angular renderer materializes this contract.

### Recommended next task

Implement an Angular-native renderer that consumes `renderedRoot` and produces
the semantic root and anatomy parts with Angular bindings and event handlers.
Add Angular TestBed DOM assertions for representative Batch A, Batch B, and
data-rich components before updating the catalog finding to resolved.

Do not replace the Angular component with catalog-owned markup: the catalog must
continue exposing the behavior of the published framework package.

## Verification summary

The catalog landing page and all 35 sampled framework routes passed locally and
on `https://uifn.dev` with no browser console errors, for 36 total checks. Each
framework exposed all 45 public catalog cards and the sampled component pages
included their live preview and implementation documentation. No additional
confirmed component-package defects were recorded during this sampling pass.
