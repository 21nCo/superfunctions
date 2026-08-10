# SFO-45 comparability rubric

This rubric defines what "comparable to shadcn and Coss UI" means for uifn. It is a clean-room product rubric, not permission to copy source, styles, prose, examples, or assets.

| Dimension | Primary reference | uifn requirement | Evidence |
| --- | --- | --- | --- |
| Component API | shadcn/ui | Framework-native open compounds with stable root/part exports; `variant`, `size`, `density`, `unstyled`, `class`/`className`, `classes`, `style`, and `styles` are public and typed. | `@uifn/components` contracts and generated React, Svelte, and Solid wrappers |
| Theming | shadcn/ui | Semantic theme variables remain consumer-owned and work in light, dark, and high-contrast modes. | `@uifn/tokens`, `@uifn/theme`, `@uifn/components/styles.css` |
| Source ownership | shadcn/ui | Package imports and registry-installed source are generated from one definition and produce the same recipe/data/style contract. | Phase 15 and 16 generation drift gates |
| Density and information design | Coss UI | Compact controls and data-heavy surfaces remain legible without collapsing target size, focus, or hierarchy. | compact/comfortable/spacious recipes and Table pilot |
| Visual finish | Coss UI | Defaults include intentional spacing, type scale, borders, elevation, icons, motion, focus, disabled, invalid, open, checked, and selected states. | public theme foundations, pilot matrix, reviewed visual evidence |
| Variant and state completeness | Coss UI | Curated pilot pages show meaningful variants, sizes, densities, and interaction states rather than one happy-path example. | `STYLED_PILOT_DEMOS` and `/components/:slug/states` |
| Documentation | Coss UI | Every component keeps live preview, source-generated usage, props, parts, states, accessibility, limitations, and QA routes together. | framework workbenches and catalog contract tests |
| Accessibility | uifn canonical behavior contracts | Visual approval never substitutes for keyboard, focus, semantic, forced-color, reduced-motion, RTL, form, and announcement verification. | phase 18/browser gates and separate functional/a11y result |
| Product identity | uifn | Semantic OKLCH themes, restrained violet-blue accent, low-specificity open styling, and framework parity remain original uifn decisions. | theme and component package sources |

## Release-blocking pilot set

React, Svelte, and Solid are release-blocking for Button, Field/Input, Checkbox, Switch, Select/Combobox, Dialog, Menu (the canonical Dropdown Menu primitive), Tabs, Card, and Table. Table is the data-heavy pilot.

## Decision rule

A dimension passes only when the public package or installed source owns it. Catalog-only presentation cannot satisfy this rubric.

## Ten-point acceptance scale

`10/10` is a release condition, not an average and not a subjective reviewer label. Every item in a row must pass for that dimension to score ten. Partial scores count the proven items only.

| Dimension | Ten independently provable points |
| --- | --- |
| Component API | Framework-native compound; stable parts; native prop forwarding; `asChild`/render composition; typed variant; typed size; typed density; unstyled escape hatch; per-part classes/styles; package and installed-source parity. |
| Theming | Semantic tokens; light; dark; forced colors; reduced motion; RTL; compact density; comfortable density; spacious density; consumer override without `!important`. |
| Visual finish | Intentional type; spacing; radius; border; elevation; icon treatment; hover; active; focus-visible; disabled/loading/invalid/selected treatment. |
| Variant and state completeness | Every advertised state renders; every state is visibly named; variants are visually distinct; text/icon contrast passes; loading is real; disabled is real; open/checked/selected are real; small/large sizes are distinct; density is distinct; no state is a duplicate fixture masquerading as coverage. |
| Composition quality | Plausible product scenario; meaningful content; primary action; secondary action or metadata; realistic data volume; empty state where applicable; loading state where applicable; error/invalid state where applicable; narrow/mobile composition; no placeholder anatomy prose. |
| Overlay quality | Backdrop covers the viewport; shell layers are visually modal; content is correctly layered; focus enters; focus is contained when modal; Escape closes; outside interaction follows policy; focus restores; long content scrolls; nested and RTL cases render. |
| Data and density | Semantic structure; compact mode; comfortable mode; spacious mode; status treatment; alignment; overflow strategy; responsive strategy; application-owned behavior boundary is explicit; an enhanced composition demonstrates sorting/filtering/selection/pagination integration when those behaviors are not core-owned. |
| Documentation | Install; usage; live preview; named examples; props with true defaults; events; anatomy; states; accessibility; limitations/integration guidance. |
| Catalog experience | Component-first hierarchy; restrained chrome; readable contrast; named previews; preview/code parity; desktop containment; 390px containment; keyboard navigation; stable framework switching; no catalog CSS impersonates public component styles. |
| Verification integrity | Unit coverage; type coverage; generated drift; package/source parity; three-framework parity; light/dark/forced-color states; interaction assertions; accessibility assertions; screenshot/contact-sheet evidence; explicit reference-dimension audit rather than self-baseline acceptance. |

## Non-negotiable failure rules

The following cap the affected dimension below ten regardless of other passing checks:

- hidden or unnamed state fixtures;
- duplicate fixtures presented as different states;
- unreadable text or icon contrast in a supported theme;
- a declared loading, disabled, open, checked, selected, invalid, or density state that does not reach the rendered DOM;
- generated documentation that contradicts the canonical runtime default;
- modal content above application chrome while its backdrop paints below that chrome;
- a catalog-only selector that supplies component geometry or visual identity absent from the public package;
- visual approval based only on uifn-owned baseline equality or a reviewer string;
- a generic anatomy fixture used where the component requires a product composition to be understood.

## Evidence contract

The authoritative status is `PARITY_INVENTORY.md`. A component reaches `10/10` only when each applicable dimension links to current source, automated output, and a real-browser capture. `VISUAL_REVIEW.json` and `BROWSER_REVIEW.json` remain historical evidence until regenerated under this rubric; their existing `accepted`/`passed` values do not prove current comparability.
