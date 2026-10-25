# Literal field saves

Original DOC-002 requires schema-driven editing, changed-field patches, authoritative producer validation, and revision conflict refresh/reapply. The prior recursive patch builder split schema field names containing dots, discarded empty objects, and skipped every underscore-prefixed property, including allowed custom fields. Two focused cases failed against the prior builder at `fe5ed4839`; log `/tmp/cms-literal-patch-baseline.log`.

The corrected builder compares sorted top-level fields and sends an atomic replacement for each changed object. This preserves literal nested keys, empty objects, canonical reference/asset/richtext data, and siblings. The existing loaded `ifRev` still guards the whole write and prevents replacing concurrent edits. Only reserved system metadata is excluded. Ordinary names retain string paths; literal top-level names use ContentFn explicit segment arrays. Object edit events name the replaced top-level object instead of individual nested leaves, matching the actual atomic operation.

Producer prerequisite: ContentFn `d25a8aa0892a22339517711e8c70369356242fea`, documented in `contentfn/.conduct/literal-patch-readiness.md`. Older producers reject the additive array syntax; deploy the prerequisite first. ContentFn remains authoritative for schema/system-field validation and revision CAS.

Combined verification passed after ordinary prerequisite merge `c8bc5f50fbf2b5d1a0fb92411a189e44f5e48b4c`:

- Node 20.20.0 / Turbo 2.8.16: `turbo run typecheck build --filter=@cmsfn/studio --filter=@cmsfn/server --filter=cmsfn`, 34 tasks passed.
- Full Studio and server Vitest suites (`--pool=threads`): 138 Studio and 130 server tests passed. Log `/tmp/cms-literal-full.log`.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness` with Node 20 PATH: normal npm 11 installation of 32 built packages; Chromium 143.0.7499.4 full App matrix, 254 requests; strict installed ESM/CJS declarations and SSR passed. Log `/tmp/cms-literal-packed.log`.
- The real App edited and persisted literal top-level and nested names, a sibling, and a custom underscore field. Existing conflict refresh/reapply, richtext, references, media, arrays, history, releases, scheduling and operational checks also passed. Unit cases cover unset/empty-object generation; the producer installed fixture covers actual unset/empty-object persistence.
- Production audit zero; copy retained at `/tmp/cms-literal-production-audit.json`. Tooling installation also reported zero. Exact owned consumer `/tmp/cms-studio-packed-tckxnsdl` was removed and absence verified; browser/server processes ended.

Native Safari has a separate blocked session-creation receipt in `native-safari-readiness.md`; it is not inferred from Chromium. Both Safari settings remain restored OFF, with no further native session launched for this correction. Deployed authentication/CORS/storage and full native acceptance remain open.

## Dependency security boundary

A zero npm audit result covers the installed dependency graph, not parser code embedded by dependency bundlers. The separate McpFn build-input prerequisite (explicit patched Zod input and bundle provenance) remains to be integrated into the CMS stack. This checkpoint must not claim embedded-parser security from its audit alone. The Content literal-path consumer excludes admin/MCP and does not validate those bundles.
