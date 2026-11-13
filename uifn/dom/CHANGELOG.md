# Changelog

## 0.0.2 - 2026-11-03

- Adds the adapter installers that `@uifn/react`, `@uifn/svelte` and `@uifn/solid` definitions list to wire a mounted primitive: `uifnOverlayAdapterBinding`, `uifnTourOverlayAdapterBinding`, `uifnMenuAdapterBinding`, `uifnNavigationMenuAdapterBinding`, and `createUIFnPopupAdapterBinding`, `createUIFnRovingFocusAdapterBinding` and `createUIFnRangeGestureAdapterBinding`, which take the primitive's parts and state keys. The installers take those from the definition instead of looking them up by primitive name, so a one-primitive app bundles only the installers and descriptors its definitions list. `createUIFnRangeGestureDomBinding` still selects its pointer handling by `primitive`, as before, so any range-gesture primitive bundles that handling for all of them.
- Depends on `@uifn/core` 0.0.3, which is side-effect free.
- The package now includes this changelog.
