# SFO-45 shadcn and Coss parity inventory

This is the release-blocking inventory for making uifn comparable to mature shadcn and Coss component catalogs without copying their source, styles, prose, examples, or assets.

## Evidence policy

- `PASS` requires current source evidence, an automated assertion, and a real-browser render where the requirement is visual or interactive.
- `PARTIAL` means useful implementation exists but one or more required proofs are missing or contradicted.
- `FAIL` means current evidence directly contradicts the requirement.
- `N/A` is allowed only when the component contract genuinely does not own that behavior; the catalog must then demonstrate the integration boundary with a realistic composition.
- Historical self-baselines do not turn `PARTIAL` or `FAIL` into `PASS`.

## Current scorecard

Baseline recorded from the 2026-08-11 source and real-browser review. These are internal release-gate scores for the Tier 0 styled-system proof set, not a claim that every one of the 69 catalog pages is independently equivalent to shadcn/ui or Coss UI. Scores move only when source, automated assertions, and visual evidence move together.

| Dimension | Tier 0 internal gate | Evidence and boundary |
| --- | ---: | --- |
| Component API | 10/10 | Stable compounds, native DOM prop forwarding, shared styled props, open recipes, package and installed-source output, and React/Svelte/Solid contract tests. |
| Theming | 10/10 | Shared semantic foundations, light/dark themes, density, RTL, reduced-motion and forced-color contracts, consumer overrides, and computed-style framework parity. The accepted contact-sheet matrix is light/dark; forced-color is covered by the accessibility gate rather than these screenshots. |
| Visual finish | 10/10 | The twelve pilots have deliberate hierarchy, state contrast, icon treatment, compact/spacious density, and reviewed light/dark output. This score does not extend automatically to Tier 1 or Tier 2. |
| Variant and state completeness | 10/10 | Named public fixtures expose default, hover, focus-visible, active, disabled, invalid, open, checked/indeterminate, selected, loading, size, density, and flagship variants where applicable. |
| Composition quality | 10/10 | Flagship pages use named, realistic product compositions instead of anatomy-only output: release health, deployment dashboard, form flows, command palette, and nested/long dialog flows. |
| Overlay quality | 10/10 | Backdrop/content layering, scoped portals, long and nested flows, focus entry/return, keyboard interaction, RTL, and escape/outside interaction are source-tested and browser-probed. |
| Data and density | 10/10 | Semantic Table, status/action content, compact/spacious presentation, overflow containment, empty/loading guidance, and the application-owned data-operation boundary are explicit. |
| Documentation | 10/10 | All public pages expose anatomy, API, accessibility, named examples, state descriptions, install guidance, source snippets, and framework-specific output. |
| Catalog experience | 10/10 | Component-first hierarchy, reduced empty canvas, visible state names, responsive routes, theme/framework parity, and public-preview isolation pass the internal gate. |
| Verification integrity | 10/10 | Fresh 72-case visual matrix, twelve reviewed contact sheets, presentation-integrity probes, package/source checks, behavioral tests, and full catalog verification reject known failure modes. Independent third-party comparison remains outside this internal score. |

## Release tiers

### Tier 0: styled-system proof set

These components must reach 10/10 first and define reusable quality patterns for the remaining inventory.

| Component | Primary proof | Current status | Accepted compositions |
| --- | --- | --- | --- |
| Button | Variants, sizes, loading and contrast | PASS | Default primary, secondary, outline, ghost, danger, icon, loading, disabled, sizes, and densities. |
| Field + Input | Form hierarchy and validation | PASS | Default, help, required, invalid, disabled, read-only, compact, and native placeholder forwarding. |
| Checkbox | Checked-state clarity | PASS | Unchecked, checked, mixed, invalid, disabled, and visible CSS fallback marks in all frameworks. |
| Switch | Compact control quality | PASS | Off, on, disabled, compact, RTL, and visually distinct disabled treatment. |
| Select + Combobox | Popup and form composition | PASS | Closed, open, selected, searchable, invalid, disabled, and cross-framework popup geometry. |
| Dialog | Modal layering and workflow | PASS | Default, confirmation, long/scrolling, nested, focus return, and RTL. |
| Menu | Dense navigation/action surface | PASS | Groups, shortcuts, selection states, disabled items, keyboard navigation, and scoped portals. |
| Tabs | Selection and responsive density | PASS | Default, compact, disabled, selected, responsive containment, and no raw indicator leakage. |
| Card | Product composition | PASS | Release-status composition plus default, elevated, outline, spacious, footer, and action treatment. |
| Table | Data and density | PASS | Semantic deployment table, statuses, actions, compact/spacious density, overflow, and application-owned data behavior. |

### Tier 1: product-critical interactive inventory

Accordion, Alert Dialog, Angle Slider, Autocomplete, Carousel, Checkbox Group, Clipboard, Collapsible, Color Picker, Command, Context Menu, Date Input, Date Picker, Drawer, Editable, Fieldset, File Upload, Floating Panel, Form, Hover Card, Image Cropper, Input Group, Listbox, Menubar, Navigation Menu, Number Input, Pagination, Password Input, Pin Input, Popover, Radio Group, Rating Group, Segment Group, Signature Pad, Slider, Splitter, Steps, Tags Input, Textarea, Toast, Toggle, Toggle Group, Toolbar, Tooltip, Tour, and Tree View.

Every Tier 1 component has public default/state/QA routes, React/Svelte/Solid source and package contract coverage, responsive catalog captures, and accessibility metadata. Overlay and data-rich components inherit the full overlay/data rows from the rubric. These components are contract-complete; they are not promoted to the Tier 0 hand-curated visual score without the same named-composition and accepted-contact-sheet evidence.

### Tier 2: structural, display and feedback inventory

Avatar, Badge, Breadcrumb, Marquee, Meter, Progress, QR Code, Scroll Area, Separator, Skeleton, and Timer.

Tier 2 has realistic content, light/dark/forced-color contracts, responsive containment, consumer styling evidence, and an explicit accessibility boundary. Like Tier 1, its catalog/build coverage is complete while its visual score remains separately auditable.

## Systemic blockers

| ID | Finding | Owner | Status | Completion evidence |
| --- | --- | --- | --- | --- |
| SYS-01 | State fixture names were hidden by catalog CSS. | catalog shell | PASS | Names are visible and asserted on public `/states` routes. |
| SYS-02 | Button child color ignored variant root color in dark mode. | public stylesheet | PASS | Variant content inherits root color; light/dark computed-style signatures are asserted. |
| SYS-03 | Button `loading` rendered as default and Spinner was hidden. | shared demo + framework fixtures | PASS | DOM exposes busy/disabled/loading and a visible spinner in React/Svelte/Solid. |
| SYS-04 | Overlay backdrop painted below catalog chrome. | public stylesheet | PASS | Backdrop/content layers sit above application chrome and preserve nested order. |
| SYS-05 | Boolean API defaults were inferred as false even when canonical policy defaulted true. | delivery generator | PASS | Defaults are explicitly mapped from canonical policy and generator output is checked. |
| SYS-06 | State pages repeated identical copy and oversized canvases. | shared presentation | PASS | Named state headers, state-specific descriptions, and tighter preview density are rendered. |
| SYS-07 | Main examples lacked product-composition depth. | shared demos + three workbenches | PASS | Tier 0 named compositions satisfy the internal composition row. |
| SYS-08 | Comparability gate validated self-baselines without presentation assertions. | verifier | PASS | The gate rejects missing visual review, matrix coverage, public-preview leakage, missing presentation probes, recipe drift, and command/build/test failures. |
| SYS-09 | Table wording advertised filter/sort/select although the core Table explicitly does not own them. | inventory + presentation | PASS | Static semantic behavior and application-owned data operations are documented separately. |
| SYS-10 | Catalog hierarchy and preview chrome overpowered simple components. | catalog shell | PASS | Component-first desktop/mobile captures and bounded preview heights pass catalog verification. |

## Per-component completion record

All 69 public components are in scope:

Accordion; Alert Dialog; Angle Slider; Autocomplete; Avatar; Badge; Breadcrumb; Button; Card; Carousel; Checkbox; Checkbox Group; Clipboard; Collapsible; Color Picker; Combobox; Command; Context Menu; Date Input; Date Picker; Dialog; Drawer; Editable; Field; Fieldset; File Upload; Floating Panel; Form; Hover Card; Image Cropper; Input; Input Group; Listbox; Marquee; Menu; Menubar; Meter; Navigation Menu; Number Input; Pagination; Password Input; Pin Input; Popover; Progress; QR Code; Radio Group; Rating Group; Scroll Area; Segment Group; Select; Separator; Signature Pad; Skeleton; Slider; Splitter; Steps; Switch; Table; Tabs; Tags Input; Textarea; Timer; Toast; Toggle; Toggle Group; Toolbar; Tooltip; Tour; and Tree View.

All 69 components have generated React/Svelte/Solid registry source, package output, catalog routes, API/anatomy/accessibility documentation, and desktop/mobile browser evidence. Tier 0 additionally has the accepted dimension-by-dimension visual gate above. No component outside Tier 0 is described as 10/10 merely because its route builds, and no internal evidence is presented as an independent third-party comparison.
