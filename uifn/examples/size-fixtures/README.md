# uifn size fixtures

Each fixture is a one-primitive app: it imports only Tabs, or only Menu, from one headless adapter's direct
subpath (`@uifn/react/tabs`, `@uifn/svelte/menu`, `@uifn/solid/tabs` and so on) and mounts it.

```
react/tabs.tsx   react/menu.tsx
svelte/tabs.ts   svelte/menu.ts   (mount Tabs.svelte / Menu.svelte)
solid/tabs.tsx   solid/menu.tsx
```

`scripts/verify-uifn-bundle-size.mjs` builds every fixture with Vite in production mode (minified, using the
Vite and framework plugin that adapter's Workbench declares), then:

- records the gzip size of the emitted JavaScript. The framework runtime (`react`, `react-dom`, `svelte`,
  `solid-js`) is external, because every app pays it once whatever it imports, so the number tracks the uifn
  code a primitive adds: the adapter, `@uifn/dom`, `@uifn/core` and their dependencies;
- fails when a fixture is over its budget in `budgets.json`;
- fails when a fixture contains code from an unrelated primitive, detected by marker strings that survive
  minification: the QR-code generator and QRCode contract, the color-picker controller, and the `@uifn/dom`
  bindings that Dialog (overlay), Select (popup), Slider (range gesture) and Menu wire, and the names and parts
  that other primitives pass to the roving-focus, gesture and popup installers (PinInput, Editable, Pagination,
  TreeView, SegmentGroup, ImageCropper, Splitter, DatePicker, and Tabs for the Menu fixtures), and the names
  Menubar and AngleSlider, which an adapter substrate that special-cases either by name would ship with every
  primitive. Each generated definition lists only the `@uifn/dom` installers, descriptors and gesture driver
  `scripts/uifn-adapter-dom-bindings.mjs` assigns to it;
- fails when an adapter source imports the `@uifn/core` root barrel instead of a subpath.

Build the adapters first, then run the check from the repository root:

```bash
npx turbo run build --filter=@uifn/react... --filter=@uifn/svelte... --filter=@uifn/solid...
node scripts/verify-uifn-bundle-size.mjs
```

## Budgets

Each budget is the measured gzip size plus 10%, rounded up. A pull request that grows a fixture past its budget
must raise the budget by editing `budgets.json` in that pull request. `--record` rewrites every budget from a
fresh measurement and refuses to record a fixture that carries unrelated primitive code:

```bash
node scripts/verify-uifn-bundle-size.mjs --record
```

Sizes here are for workspace builds. Sizes against published tarballs are not measured here.
