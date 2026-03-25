# PHASE 00: Project Scaffold

## Phase Goal

Create the SvelteKit 2 project at `docsfn/docs/` with all dependencies, configuration files, and minimal content to boot the dev server.

## In Scope

- package.json with all dependencies
- svelte.config.js with docsfn package aliases
- vite.config.ts with SvelteKit + Tailwind
- docsfn.config.ts (full native config)
- tsconfig.json
- src/app.html (SvelteKit shell)
- src/app.css (global styles + Tailwind + theme tokens)
- Minimal content: content/docs/index.md, content/api/index.md, content/blog/ (empty dir)
- meta.json files for root docs and api
- static/ directory
- tailwind.config.ts (or CSS-based Tailwind v4 config)

## Out of Scope

- Route files (Phase 1)
- Full content (Phases 2-8)
- Search wiring (Phase 9)
- Visual polish (Phase 10)

## Deliverables

| File | Description |
|---|---|
| `docsfn/docs/package.json` | Project manifest with deps: @sveltejs/kit ^2.0.0, @sveltejs/adapter-auto ^3.0.0, svelte ^5.0.0, tailwindcss ^4.0.0, @docsfn/core *, @docsfn/sveltekit *, @docsfn/svelte *, @docsfn/provider-fs * |
| `docsfn/docs/svelte.config.js` | Adapter-auto, vitePreprocess, aliases for @docsfn/core, @docsfn/provider-fs, @docsfn/sveltekit, @docsfn/svelte pointing to source |
| `docsfn/docs/vite.config.ts` | sveltekit() plugin |
| `docsfn/docs/docsfn.config.ts` | Full config as defined in SPEC.md Public API section |
| `docsfn/docs/tsconfig.json` | Extends SvelteKit defaults |
| `docsfn/docs/src/app.html` | Standard SvelteKit shell with %sveltekit.head% and %sveltekit.body% |
| `docsfn/docs/src/app.css` | Tailwind imports, CSS custom properties for theme tokens, dark mode via prefers-color-scheme |
| `docsfn/docs/content/docs/index.md` | Minimal placeholder: title "docsfn Documentation" |
| `docsfn/docs/content/docs/meta.json` | Root navigation with "index" entry |
| `docsfn/docs/content/api/index.md` | Minimal placeholder: title "API Reference" |
| `docsfn/docs/content/api/meta.json` | Root navigation with "index" entry |
| `docsfn/docs/static/` | Empty directory (or with favicon) |

## Requirements Covered

- SITE-001, SITE-002, SITE-003, SITE-004, THEME-002

## Implementation Tasks

1. Create `docsfn/docs/` directory
2. Create `package.json` with name `@docsfn/docs`, scripts (dev --port 6004, build, preview --port 6004), and all dependencies. MUST NOT include any fumadocs-* package
3. Create `svelte.config.js` with adapter-auto, vitePreprocess, and aliases:
   - `@docsfn/core` → `../../core/src/index.ts`
   - `@docsfn/provider-fs` → `../../provider-fs/src/index.ts`
   - `@docsfn/sveltekit` → `../../sveltekit/src/index.ts`
   - `@docsfn/svelte` → `../../svelte/src/index.ts`
4. Create `vite.config.ts` with sveltekit plugin
5. Create `docsfn.config.ts` exporting the config object per SPEC.md
6. Create `tsconfig.json` extending `.svelte-kit/tsconfig.json`
7. Create `src/app.html` with standard SvelteKit template
8. Create `src/app.css` with:
   - Tailwind base/components/utilities imports
   - CSS custom properties matching superfunctions theme (primary colors, fonts, spacing)
   - Dark mode variables via `@media (prefers-color-scheme: dark)`
   - Layout max-width `1600px` (matching `--fd-layout-width`)
9. Create `content/docs/index.md` with frontmatter: title, description
10. Create `content/docs/meta.json` with pages: ["index"]
11. Create `content/api/index.md` with frontmatter: title, description
12. Create `content/api/meta.json` with pages: ["index"]
13. Create `content/blog/` directory (empty for now)
14. Create `static/` directory
15. Run `npm install` in `docsfn/docs/`

## Verification Steps

1. `cd docsfn/docs && npm install` → exits 0
2. `grep -c "fumadocs" docsfn/docs/package.json` → returns 0
3. `npx docsfn validate --root .` (from docsfn/docs/) → exits 0 (or warnings only, no errors)
4. Verify `package.json` has port 6004 in dev and preview scripts

## Stop Condition

Report: package.json created with correct dependencies, config validates, npm install succeeds. Ready for route files in Phase 1.
