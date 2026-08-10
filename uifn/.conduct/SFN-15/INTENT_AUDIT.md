# SFN-15 Intent Audit

## Intent Inventory

1. Create a new `uifn/.conduct/SFN-15` folder for detailed specs and sub-specs.
2. Make `uifn` production-ready.
3. Support React, Svelte, Vue, Solid, and Angular.
4. Provide all base components listed in the Coss UI docs.
5. Include hooks listed in the Coss UI docs.
6. Use Coss as a capability/reference target only.
7. Use clean-room implementation with no copied code.
8. Support both package imports and source installation.
9. Use the recommended package architecture including core, adapter-kit, framework adapters, components, patterns, sf, registry, and Storybook.
10. Support both CSS-variable/design-token-first styling and Tailwind integration.
11. Split styling into `@uifn/tokens`, `@uifn/theme`, `@uifn/theme-tailwind`, and `@uifn/recipes`.
12. Use semantic public token names rather than cryptic product-specific shorthand.
13. Use W3C Design Tokens-style JSON as the theme file format.
14. Use OKLCH for color ramps and custom hues.
15. Provide first-party light, dark, high-contrast light, and high-contrast dark themes.
16. Support brand/custom theme generation.
17. Support both semantic surfaces and numeric `surfaceDepth`.
18. Make hover and active effects recipe options, with non-universal striped hover.
19. Make Tailwind generated from CSS variables and static recipes, not the source of truth.
20. Avoid dynamic Tailwind class generation that breaks builds.
21. Require automated contrast validation.
22. Provide styled components with unstyled escape hatches.
23. Make recipes output class names, styles, CSS variables, and data attributes.
24. Use Storybook as the consumer-facing workshop/test/docs surface.
25. Borrow Bit concepts only, not Bit as a required toolchain.
26. Include component manifests with ownership, version/status, dependencies, tests, stories, framework support, and source policy.
27. Provide source-installable registry items with stories, fixtures, tests, manifests, and lock entries.
28. Let consumers curate installed `uifn` components and detect local drift.
29. Provide controlled product patterns without backend binding.
30. Provide Superfunction-backed pattern variants.
31. Phase-one Superfunction-backed patterns should cover `authfn`, `plugfn`, `filefn`, and `billfn`.
32. Superfunction-backed patterns must use injected clients and not app-global singletons.
33. Allow breaking changes because no one is using `uifn` yet.
34. Avoid backward compatibility and legacy scaffolding.
35. Do not add product-specific public packages or themes.
36. Preserve uniform behavior, accessibility, part names, state/data attributes, and conformance while allowing each framework to use native ergonomics.
37. Provide production release gates for build, lint, typecheck, tests, export maps, pack hygiene, docs, Storybook, accessibility, visual tests, and manifest validation.
38. Avoid absolute local paths in committed spec artifacts.

## Coverage Map

| Intent | SPEC.md coverage | Requirements | Test vectors |
| --- | --- | --- | --- |
| 1 | Metadata, Overview | ARCH-001 | TV-ARCH-001 |
| 2 | Overview, Goals, Production release semantics | TEST-001, TEST-002 | TV-RELEASE-001, TV-RELEASE-002 |
| 3 | Goals, Framework Adapter APIs | ADAPT-001 to ADAPT-006 | TV-ADAPT-001 to TV-ADAPT-006 |
| 4 | Goals, Component Semantics | COMP-001 | TV-CATALOG-001 |
| 5 | Goals, Hooks API | HOOK-001 | TV-HOOK-001 |
| 6 | Overview, Non-goals | ARCH-002 | TV-ARCH-003 |
| 7 | Overview, Non-goals, Security | ARCH-002 | TV-ARCH-003 |
| 8 | Public API, Registry and CLI API | REG-002 | TV-REG-002 |
| 9 | Package Architecture | ARCH-001 | TV-ARCH-001, TV-ARCH-002 |
| 10 | Styling APIs, Styling Semantics | STYLE-001 to STYLE-006 | TV-STYLE-001 to TV-STYLE-006 |
| 11 | Package Architecture, Styling APIs | STYLE-001 to STYLE-006 | TV-STYLE-001 to TV-STYLE-006 |
| 12 | Styling APIs | STYLE-001 | TV-STYLE-001 |
| 13 | Data Formats, Theme Token File | STYLE-001 | TV-STYLE-001 |
| 14 | Styling Semantics | STYLE-003 | TV-STYLE-003 |
| 15 | Styling Semantics | STYLE-002 | TV-STYLE-002 |
| 16 | Styling Semantics | STYLE-003 | TV-STYLE-003 |
| 17 | Styling APIs | STYLE-004 | TV-STYLE-004 |
| 18 | Styling APIs, Styling Semantics | STYLE-006 | TV-STYLE-006 |
| 19 | Styling Semantics | STYLE-005 | TV-STYLE-005 |
| 20 | Styling Semantics | STYLE-005 | TV-STYLE-005 |
| 21 | Styling Semantics, Invariants | STYLE-003, TEST-002 | TV-STYLE-003, TV-RELEASE-002 |
| 22 | Components API | COMP-002 | TV-COMP-001 |
| 23 | Styling APIs | STYLE-006 | TV-STYLE-006 |
| 24 | Storybook API and Semantics | STORY-001, STORY-002 | TV-STORY-001, TV-STORY-002 |
| 25 | Package Architecture, Registry semantics | REG-001 | TV-REG-001 |
| 26 | Component Manifest | REG-001 | TV-REG-001 |
| 27 | Registry and CLI API | REG-002 | TV-REG-002 |
| 28 | Registry Lock, CLI API | REG-002 | TV-REG-002 |
| 29 | Pattern Semantics | PAT-001 | TV-PAT-001 |
| 30 | Patterns and Superfunction API | SF-001 | TV-SF-001 |
| 31 | Patterns and Superfunction API | SF-002 | TV-SF-002 |
| 32 | Security, Patterns and Superfunction API | SF-001, SEC-001 | TV-SF-001, TV-SEC-001 |
| 33 | Compatibility and Versioning | VER-001 | TV-VER-001 |
| 34 | Non-goals, Compatibility and Versioning | VER-001 | TV-VER-001 |
| 35 | Non-goals, Undefined | STYLE-001, VER-001 | TV-STYLE-001, TV-VER-001 |
| 36 | Framework Adapter APIs, Component Semantics | CORE-002, ADAPT-001 | TV-CORE-003, TV-ADAPT-001 |
| 37 | Observability, Production release gate | TEST-001, TEST-002, DOCS-001 | TV-RELEASE-001, TV-RELEASE-002, TV-DOCS-001 |
| 38 | Metadata, Invariants, Observability | DOCS-001, SEC-001 | TV-DOCS-001, TV-SEC-001 |

## Missing Intent Items

No missing intent items.
