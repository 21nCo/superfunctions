# Richtext block authoring and producer limits

The phase-05 basic block-array editor and phase-08 media insertion now retain canonical
ContentFn richtext instead of flattening it into one textarea. Individual span edits
preserve block/span keys, styles, marks, annotation definitions and untouched blocks.
New blocks/spans receive keys; allowed marks are editable; blocks can be reordered or
removed. Custom objects and malformed legacy values remain visible without silent
coercion. Media insertion is offered when the schema permits asset objects and appends a
canonical keyed asset without overwriting text edited while the library was open.

Rendering pages contain at most 20 blocks or spans without truncating stored data.
External shrink uses the effective page for navigation. Pending media selection is bound
to document/field, schema, limits and value generation; normal controlled edits preserve
ownership while external replacement or reduced limits invalidate the selection.
Objects and array-item richtext use the same widgets and literal-field ownership.

LIMIT-001's default 5000 blocks per field and the configured override are applied to
nested save and conflict-reapplication prechecks. ContentFn independently enforces the
same contract across create/patch/fork, publish/scheduled publish, restore and imports.
The producer prerequisite is c3ec880facb69bf8e4826398db18f96d6014722d, merged into this
branch at 18cb5c69a3b24f739cd5b617a188d8ee94b4dc1f. See ContentFn's richtext-limits
receipt for its 212 passing tests, two provider skips, native SQLite and installed HTTP
checks. Imported history only carries the latest archive schema: removed historical
fields cannot be classified globally as richtext; current-schema restore/publish remain
validated. Oversized existing values remain readable and can be reduced.

Validation on Node 20.20.0:

- Three initial failing authoring tests demonstrated missing block controls, destructive
  text flattening and malformed-child crashes (`/tmp/cms-richtext-baseline.log`).
- `npx turbo run typecheck test build --filter=@cmsfn/studio`: 136 tests / 25 files,
  typecheck and ESM/CJS declarations passed; 29 successful tasks, 26 cached. Nine new
  richtext tests cover preservation, canonical creation/marks, malformed data, pagination,
  cap changes during media selection, intervening edits and nested limits.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root
  /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`: fresh normal npm11
  installation of 32 packed packages, strict TypeScript and ESM/CJS consumers, native
  Chromium 143.0.7499.4 full App and 254 actual HTTP requests passed. Actual ContentFn
  persistence verifies preserved annotations/keys, media insertion, nested array richtext
  and server rejection of a four-block write with configured limit three without revision
  change. Existing full App acceptance remains included.
- Production-only audit and separate browser-tooling installation both reported zero
  vulnerabilities. CMS server source did not change; no new full CMS server suite is
  claimed. ContentFn validation is recorded separately in its prerequisite receipt.

Receipts: `/tmp/cms-richtext-{focused,types-final,validation,packed}.log` and
`/tmp/cms-richtext-production-audit.json`. The exact disposable consumer
`/tmp/cms-studio-packed-lzzsc2im` was removed and read back absent; owned browser, HTTP
and test processes completed. Native Safari and deployed authentication/CORS/storage
remain outside this local installed Chromium evidence. This implements basic block
editing, not collaborative WYSIWYG or arbitrary custom-object design, and does not claim
all remaining operational requirements are complete.
