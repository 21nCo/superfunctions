# Sub-spec: Architecture and Packaging

## Purpose

Define the package graph, dependency rules, export-map rules, public status metadata, and cleanup posture for SFN-15.

## Package Ownership

| Package | Role | May depend on | Must not depend on |
| --- | --- | --- | --- |
| `@uifn/core` | behavior controllers, state, ARIA, utils | none except low-level runtime deps approved by release gate | framework adapters, styling packages, components, patterns |
| `@uifn/adapter-kit` | adapter helpers and conformance harness | `@uifn/core` | app components, styled components, Superfunction packages |
| `@uifn/react` | React unstyled primitives | `core`, `adapter-kit`, React peer deps | `components`, Tailwind, Storybook |
| `@uifn/svelte` | Svelte unstyled primitives | `core`, `adapter-kit`, Svelte peer deps | `components`, Tailwind, Storybook |
| `@uifn/vue` | Vue unstyled primitives | `core`, `adapter-kit`, Vue peer deps | `components`, Tailwind, Storybook |
| `@uifn/solid` | Solid unstyled primitives | `core`, `adapter-kit`, Solid peer deps | `components`, Tailwind, Storybook |
| `@uifn/angular` | Angular unstyled primitives | `core`, `adapter-kit`, Angular peer deps | `components`, Tailwind, Storybook |
| `@uifn/tokens` | token schema and validation | color/parser utilities if approved | framework packages |
| `@uifn/theme` | CSS variable runtime and theme context | `tokens` | Tailwind, framework adapters |
| `@uifn/theme-tailwind` | Tailwind preset/plugin generation | `tokens`, `theme`, `recipes` | framework adapters |
| `@uifn/recipes` | typed style recipes | `tokens`, `theme` | Tailwind runtime, framework adapters |
| `@uifn/components` | styled components by framework entry point | adapters, recipes, theme | Superfunction clients |
| `@uifn/patterns` | controlled product patterns | components | Superfunction clients |
| `@uifn/sf` | Superfunction-backed patterns | patterns, typed Superfunction client contracts | app-global clients, secrets |
| `@uifn/registry` | manifests, registry build, CLI | none or manifest schema helpers | framework runtime packages unless required for fixture compile |
| `@uifn/storybook` | Storybook preset/addon | registry, theme, mock helpers | production app secrets |

## Export Map Rules

Each package MUST define explicit `exports`.

Framework-specific component entry points MUST be explicit:

```json
{
  "exports": {
    "./react": { "types": "./dist/react/index.d.ts", "import": "./dist/react/index.mjs" },
    "./svelte": { "types": "./dist/svelte/index.d.ts", "svelte": "./src/svelte/index.ts" },
    "./vue": { "types": "./dist/vue/index.d.ts", "import": "./dist/vue/index.mjs" },
    "./solid": { "types": "./dist/solid/index.d.ts", "import": "./dist/solid/index.mjs" },
    "./angular": { "types": "./dist/angular/index.d.ts", "import": "./dist/angular/index.mjs" }
  }
}
```

Deep internal imports MUST be rejected unless listed as public subpaths.

## Status Metadata

Every package MUST include:

```json
{
  "uifn": {
    "status": "ga-candidate",
    "layer": "adapter",
    "schemaVersion": 1,
    "sourcePolicy": "clean-room"
  }
}
```

Allowed statuses:

- `experimental`
- `beta`
- `ga-candidate`
- `ga`
- `deprecated`

`deprecated` MUST NOT be used during SFN-15 unless a post-GA migration is introduced. Pre-GA legacy APIs SHOULD be removed.

## Workspace Rules

- Workspaces MUST be added under the root npm workspace configuration.
- Nested monorepos MUST NOT be introduced.
- Existing `uifn` packages MAY be rewritten in place.
- Build outputs MUST be excluded from source control unless the repository already tracks them by policy.
- Package READMEs MUST state whether the package is runtime, build-time, or registry/dev-only.

## Production-Ready Gates

Architecture is complete only when:

- package graph validation passes,
- export-map validation passes,
- manifest status validation passes,
- every public package can be packed without tests, fixtures, or private internals leaking,
- docs and manifests agree on package names and status.

