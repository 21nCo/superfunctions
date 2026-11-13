# Changelog

## 0.0.2 - 2026-11-03

- Adds the adapter installers that `@uifn/react`, `@uifn/svelte` and `@uifn/solid` definitions list to wire a mounted primitive: `uifnOverlayAdapterBinding`, `uifnTourOverlayAdapterBinding`, `uifnMenuAdapterBinding`, `uifnNavigationMenuAdapterBinding`, `createUIFnPopupAdapterBinding` (the trigger part, the reference parts and whether to match the reference width), `createUIFnRovingFocusAdapterBinding` (a state key and value-scoped parts, or a roving target such as `uifnMenubarRovingTarget`) and `createUIFnRangeGestureAdapterBinding` (a gesture driver, then the surface parts and entry parts). The installers take these from the definition instead of looking them up by primitive name, so a one-primitive app bundles only the installers and descriptors its definitions list.
- Adds one range-gesture driver per primitive (`uifnSliderGestureDriver`, `uifnAngleSliderGestureDriver`, `uifnCarouselGestureDriver`, `uifnSignaturePadGestureDriver`, `uifnSplitterGestureDriver`, `uifnImageCropperGestureDriver`, `uifnColorPickerGestureDriver`, `uifnScrollAreaGestureDriver`) and `createUIFnRangeGestureDriverBinding`, which binds a surface to one driver, so a Slider app bundles only the Slider pointer mapping. `createUIFnRangeGestureDomBinding` keeps its signature and behavior; it selects the driver by `primitive`, so it bundles all eight.
- Depends on `@uifn/core` 0.0.3, which is side-effect free.
- The package now includes this changelog.
