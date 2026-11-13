# Changelog

## 0.0.2 - 2026-11-03

- Adds the adapter installers that `@uifn/react`, `@uifn/svelte` and `@uifn/solid` definitions list to wire a mounted primitive: `uifnOverlayAdapterBinding`, `uifnTourOverlayAdapterBinding`, `uifnMenuAdapterBinding`, `uifnNavigationMenuAdapterBinding`, and `createUIFnPopupAdapterBinding`, `createUIFnRovingFocusAdapterBinding` and `createUIFnRangeGestureAdapterBinding`, which take the primitive's parts and state keys. Installers never branch on a primitive name, so a one-primitive app bundles only the installers it lists.
- Depends on `@uifn/core` 0.0.3, which is side-effect free.
- The package now includes this changelog.
