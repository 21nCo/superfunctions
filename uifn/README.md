# uifn

`uifn` is an unstyled primitives package family with a shared core plus framework adapters.

## Canonical Package Contract

No deprecated `uifn` alias is published for core. The canonical package names are:

- `@uifn/core` (GA)
- `@uifn/react` (GA)
- `@uifn/svelte` (GA)
- `@uifn/vue` (Experimental)
- `@uifn/files` (Experimental)

## Support Matrix

| Package | Status | Notes |
| --- | --- | --- |
| `@uifn/core` | GA | Source of shared primitive/state/ARIA utilities |
| `@uifn/react` | GA | React 18.2+ adapter |
| `@uifn/svelte` | GA | Svelte 5.x adapter |
| `@uifn/vue` | Experimental | Public API may change outside semver guarantees |
| `@uifn/files` | Experimental | File UX helper package; boundary is explicit and documented |

Unsupported adapters such as Solid and web-components are not part of the current public support claims.

## Display Helpers Contract

- `Avatar`, `Badge`, `Label`, and `Separator` are GA surfaces in `@uifn/react` and `@uifn/svelte`.
- The same families are available in `@uifn/vue` as Experimental because the package is Experimental.
- `VirtualizedList` is an adapter-only helper (not exported by `@uifn/core`) and is currently shipped by React and Svelte adapters.
- `Avatar` fallback rendering is deterministic: fallback UI appears when image loading fails or no image source is available, and honors optional fallback delay props.
- `VirtualizedList` uses a deterministic windowing contract with `overscan` (default `3`) plus adapter render hooks (`renderItem` in React, snippet children in Svelte).

## Install

```bash
npm install @uifn/core @uifn/react @uifn/svelte
```

Experimental packages are opt-in:

```bash
npm install @uifn/vue @uifn/files
```

## Compatibility Matrix

- Node.js: `18.x`, `20.x`, `22.x`
- React: `18.2+`
- Svelte: `5.x`
- Vue (experimental): `3.5+`
- Browsers: current evergreen Chrome, Edge, Firefox, Safari

## Local Release Gate

```bash
npm run verify:uifn-release -- --dry-run
```

The release gate command is implemented at `scripts/verify-uifn-release.mjs` and enforces package-level build/lint/test/type/export-map/pack checks.

## Example Playgrounds

Scenario-driven example apps live in [`uifn/examples/README.md`](./examples/README.md).

Run the example bundle verification from the repository root:

```bash
npm run verify:uifn-examples
```

The example hub documents the React playground, Svelte playground, and experimental Vue playground, along with their fixed local dev ports.

## License

MIT
