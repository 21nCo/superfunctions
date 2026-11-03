# Changelog

## 0.0.2 - 2026-11-03

- Regenerated the source catalog so each component records `@uifn/react` 0.0.4, `@uifn/svelte` 0.0.4 and `@uifn/solid` 0.0.2 as its runtime adapter.
- `uifn init` presets pin `@uifn/react` 0.0.4, `@uifn/svelte` 0.0.4, `@uifn/solid` 0.0.2 and `@uifn/components-{react,svelte,solid}` 0.0.2, matching the catalog. Source installs reject a project whose adapter pin differs from the catalog. The Svelte preset still pinned `@uifn/svelte` 0.0.1 while the catalog recorded 0.0.3.
