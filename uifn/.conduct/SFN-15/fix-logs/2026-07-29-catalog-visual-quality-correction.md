# Catalog visual-quality correction

Date: 2026-07-29

## Correction

The production-readiness conclusion in
`2026-07-29-catalog-sites-production-readiness.md` was too broad. Its
`215/215` browser result established route delivery, component anatomy,
interaction, accessibility automation, responsive containment, exports, and
catalog documentation. It did **not** establish that the styled component
previews met a shadcn/ui- or Coss-level visual/product bar.

The deployed catalog screenshots for Angle Slider, Image Cropper, Slider,
Color Picker, and Checkbox disproved the visual-readiness claim. They showed
browser-default controls, placeholder anatomy copy, collapsed geometry, and
overlapping labels. The deployment must therefore be treated as an
alpha-quality visual failure, not as proof that `@uifn/components-*` is
production-ready.

This correction does not delete or rewrite the earlier evidence. It narrows
what that evidence is allowed to prove.

## Root causes

1. `component-demo.ts` generated previews by recursively rendering the complete
   primitive anatomy. It invented fallback strings such as `Component content`,
   `Example label`, and `control example` instead of composing believable
   product examples.
2. The public styled layer did not have sufficient layout recipes for several
   complex compounds. Correct headless anatomy therefore rendered as tiny,
   browser-default controls.
3. A stale catalog-only CSS section overrode the public component styles and
   introduced fake labels and invalid geometry.
4. The visual verifier checked that components existed and fit in their
   container, but it did not reject placeholder prose, overlap, collapsed
   controls, missing imagery, or browser-default presentation.
5. Passing keyboard and axe checks was incorrectly promoted into a claim about
   overall component-library polish.

## Repair made locally

- Replaced generator fallback copy with curated, component-specific content.
- Added real preview data and a real crop image asset.
- Added handwritten catalog compositions where generic anatomy order was not a
  valid product example, including Form and nested Tree View.
- Added public styled recipes for Checkbox, Slider, Angle Slider, Color Picker,
  Image Cropper, Progress, Meter, Radio Group, Checkbox Group, Segment Group,
  Listbox, Select, Tree View, and related state surfaces.
- Fixed Image Cropper image hydration and percentage crop geometry.
- Fixed the single-thumb Slider range so it starts at the minimum.
- Fixed Combobox ownership of `aria-activedescendant`.
- Fixed React focus/blur event normalization so focus entering a nested
  composite child does not reset the parent controller.
- Added screenshot capture, placeholder rejection, geometry checks, image-ready
  checks, overlap-sensitive behavior checks, and diagnostic focus evidence to
  the catalog verifier.
- Added a generated-snippet placeholder regression test across all components
  and all three supported frameworks.
- Added shared anchored-popup DOM binding and wired Autocomplete, Combobox,
  Select, Color Picker, and Date Picker through it in React, Svelte, and Solid.
- Added keyboard and pointer interaction for Color Picker area and channel
  sliders, including value updates, positioning stability, Escape handling,
  and focus return.
- Fixed Autocomplete so its input is also the popup trigger/reference, matching
  its public anatomy rather than requiring a nonexistent separate trigger.
- Preserved values for repeated anatomy parts and added missing-value guards so
  generated fixtures can no longer serialize object placeholders into IDs.
- Fixed single-select Listbox form serialization so its hidden input follows
  the selected item; multiple/native choice controls retain per-item values.
- Made Toast dismissal labeling a protected core accessibility invariant while
  retaining message customization, and aligned dismissal behavior across all
  three framework adapters.
- Added complete popup, dialog, drawer, navigation, menu, form-control, status,
  cropper, slider, and color-control visual recipes to the public
  `@uifn/components` stylesheet.
- Corrected Carousel responsive composition after the broad screenshot review:
  viewport, previous/next controls, indicators, and live status now occupy
  stable grid areas at desktop and 390px mobile widths.

## Final local evidence

- Shared demo tests: 17/17 passed.
- Core: typecheck passed; 32 test files and 175 tests passed.
- React: typecheck passed; 11 test files and 24 tests passed.
- Svelte: zero type errors/warnings; 4 test files and 12 tests passed.
- Solid: typecheck, 11 client tests, and 2 SSR tests passed.
- React event bridge regression tests: 3/3 passed.
- Catalog snippets: 183/183 passed.
- React, Svelte, and Solid catalog builds passed.
- Catalog performance budgets passed for all three frameworks.
- Canonical catalog plus phase 11, 12, 13, 15, and 16 generator drift checks
  passed.
- Targeted cross-framework interaction reports passed for Color Picker, Toast,
  Listbox, and Carousel.
- The final production-output browser matrix passed all 215 checks with 0
  findings, 0 blocking findings, 0 failures, and 0 navigation retries:
  `uifn/.conduct/evidence/catalog-sites-full-final-50/verification.json`.
- The final matrix covered all 61 components in React, Svelte, and Solid,
  component composition, actual interactions, form state, Axe checks,
  production delivery, catalog routes, open-state geometry, 390px responsive
  containment, console errors, and focus return.
- Manual visual review covered all 64 React desktop captures, all 62 React
  mobile captures, all 16 React open-state captures, direct full-resolution
  review of the five user-reported failures, and representative Svelte/Solid
  parity captures. Carousel was rejected during that review, repaired, and
  included in the final green matrix.
- The two public stylesheet copies are byte-identical.

No repaired catalog was deployed as part of this correction. Any existing
remote deployment still shows the old failed build until a separately
authorized deployment publishes this source state.

## New release rule

The styled component catalog may be called visually production-ready only when:

1. every one of the 61 component previews has a curated, plausible example;
2. all React, Svelte, and Solid previews pass behavior, accessibility,
   responsive, and composition checks;
3. screenshots show no placeholder prose, overlap, clipping, collapsed
   geometry, missing media, or browser-default layout;
4. open overlays and interaction states are visually reviewed where the closed
   screenshot cannot prove the component;
5. public styles, rather than catalog-only fake content, produce the result;
6. a fresh staged build passes the complete gate and is manually reviewed
   before deployment.

Those local conditions now pass. The honest status is:

- headless/core implementation: advanced release candidate;
- styled component packages: locally usable release candidate with a complete
  styled/precomposed catalog surface;
- catalog sites: current local production build passes the complete gate and
  visual review; any older deployed build remains failed/outdated;
- shadcn/ui or Coss comparison: the broken visual floor has been corrected and
  the local component output is now credible and comparable at the individual
  component/catalog level. Ecosystem adoption, community breadth, design
  variants, and years of external production exposure are not established by
  this local result and must not be claimed as parity.

## Production deployment follow-up

Date: 2026-07-30

The reviewed catalog build was subsequently deployed to
`https://uifn.dev` with:

- catalog build: `2026-07-29T11:34:20.636Z`;
- Cloudflare Worker version:
  `fa965c46-df55-4352-8241-989586e41445`;
- Worker source hash:
  `8f27c4a2d2f67f948536a250ec6724ad066409be96a69193293309de44162b59`;
- inventory: 61 components, 2 hooks, 14 patterns, and 14 Superfunction
  panels;
- delivery surface: 2,805 statically addressable framework routes.

The deployment command required the manifest, landing page, React, Svelte,
Solid, and 404 sentinels to report the expected catalog and Worker identities
twice consecutively.

A post-deployment Chromium smoke then exercised Angle Slider, Image Cropper,
Slider, Color Picker, Checkbox, and Carousel across React, Svelte, and Solid.
It passed 47/47 checks with zero findings, blocking findings, failures, or
navigation retries:

`uifn/.conduct/evidence/catalog-sites-production-postdeploy-51/verification.json`.
