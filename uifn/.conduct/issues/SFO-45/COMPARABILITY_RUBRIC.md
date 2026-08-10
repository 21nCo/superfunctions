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
