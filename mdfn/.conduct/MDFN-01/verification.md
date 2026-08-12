# MDFN-01 Verification Contract

## Required gates

- Package graph: exact internal edges, stable/optional boundary, no cycles, framework isolation, neutral-runtime isolation, release inventory.
- Type/build/test: every package typechecks, builds, and runs its tests independently.
- Preservation corpus: LF/CRLF/CR, Unicode, GFM, opaque/raw HTML, extension blocks, and edited-region normalization.
- Security: URL/raw HTML/paste/limit/server/collaboration/AI policies.
- Adapter parity: the same transaction vector yields the same Markdown, selection, diagnostics, version sequence, and cleanup state in vanilla, React, Svelte, and Solid bindings.
- Lifecycle: subscriptions, DOM views, awareness, and fallback editors clean up exactly once.
- Packaging: `npm pack --dry-run --json` for every public package and isolated consumer installs for stable facade/framework packages.
- Runtime exports and SSR: packed React, Svelte, and Solid consumers must load their published ESM/CJS contracts, resolve every certified extension subpath, complete production and SSR builds, and execute the SSR output.
- Browser behavior: Chromium, Firefox, WebKit, and mobile Chromium must cover keyboard editing, the shared paste policy, composition, file drop, accessibility semantics, actual mounted adapter parity, and cleanup.
- Ecosystem: DocsFn canonical parse, ContentFn Markdown schema validation, CmsFn Markdown widget, SearchFn extraction, server/client CRUD and collaboration update exchange.

## Development performance budget

On the supported Node 20-24 range, a representative Markdown document above 200 KiB must parse, exact no-edit serialize, and securely render in under five seconds in the single-process verification runner. The budget is intentionally environment-tolerant; release tracking records finer parse, edit, and render percentiles before changing it.

## Commands

`npm run verify:mdfn-package-graph` performs the static architecture gate. `npm run verify:mdfn` performs per-package typecheck, test, build, packed-file, packed-consumer, SSR, and browser verification. `npm run verify:mdfn-consumers` and `npm run verify:mdfn-browser` run the two environment gates independently. The completion report records exact commands, outputs, and any environment-only gap.

## Failure policy

No warning is relabeled as a pass. A failed required command blocks completion unless evidence shows an unrelated pre-existing repository failure; that distinction is recorded with the smallest reproducer. Browser, registry, deployment, or remote CI claims require their own evidence and are not inferred from local builds.
