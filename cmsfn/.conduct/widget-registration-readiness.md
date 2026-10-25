# Public custom widget registration

PLUG-001 is an original P1 SHOULD requirement: developers can register schema-field or
field-kind widgets, with deterministic conflict resolution. Its existing source-only
tests imported the internal registry directly. At `a18e592073ca72d0c7b6cd2784905f6e90cef1ed`,
the Studio root entrypoint did not export registration and its package export map blocked
deep imports. The editor could consume registrations that package users could not make.

The public `@cmsfn/studio` entrypoint now exports `registerWidget`, `WidgetSelector`,
`CustomWidgetProps` and `CustomWidgetComponent`. It reuses the existing registry and
editor renderer. More-specific selectors retain precedence; equal specificity uses the
latest registration. Literal field names remain literal, and caller mutation cannot
change the copied selector.

Runtime validation rejects malformed JavaScript selectors, unknown/symbol keys,
accessors, inherited selector objects and nonfunction components before registry mutation.
Optional undefined selector values are ignored; at least one nonempty string must remain.
Validation never invokes selector accessors or the component. Components remain explicit
trusted application code registered before mounting the Studio, not serialized content,
a reactive subscription or an automatic server-side plugin loader. Host-requested rendering
executes the registered component; normal schema, revision and permission checks still
apply to its emitted value on save.

## Installed baseline and acceptance

Before editing, the existing built Studio was packed with `npm pack --ignore-scripts`.
The baseline archive was `cmsfn-studio-0.0.2.tgz`, SHA-1
`5c27ee1474ae7916d682bf443e1c30fc2905fb16`; its npm JSON receipt is retained in
`/tmp/cms-widget-baseline-pack.json`.

The existing isolated acceptance fixture normally installed that tarball first.
`typeof studio.registerWidget === 'function'` failed with actual `undefined`, exit 1.
The fixture required that precise failure, then normally installed the candidate tarball
and continued through complete acceptance. This was an actual package-install baseline,
not only an inspection of source exports.

Node 20.20.0 validation:

- Five focused widget tests passed, including public-entrypoint rendering/editing,
  copied literal selectors, precedence and malformed JavaScript rejection without
  changing the winning registration. Final explicit counters confirm neither getters
  nor component code run during registration/validation.
- `npx turbo run typecheck test build --filter=@cmsfn/studio`: 29 successful tasks
  (26 cached), all 140 Studio tests, Studio types and ESM/CJS declarations/builds passed.
  Core/server full suites were not rerun because their source did not change.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root
  /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness --widget-baseline
  /tmp/cms-widget-baseline-0EYUPb/cmsfn-studio-0.0.2.tgz`: fresh normal 32-package install,
  baseline reproduction, candidate reinstall, strict ESM/CJS consumers, existing
  operational JavaScript boundary checks and Chromium 143.0.7499.4 full App passed.
  The fixture made 255 actual HTTP requests against matching clean ContentFn producer
  `d25a8aa0892a22339517711e8c70369356242fea`.
- The actual browser registered two specific widgets for `post` / `literal.title`,
  then a less-specific field-only widget. Only the second specific widget rendered.
  Editing it persisted the literal field through ContentFn patch/save and actual readback,
  while the existing sibling, conflict, workflow, preview, media, reference, history,
  release and operational acceptance matrix remained included.
- Production-only audit and the separate tooling install reported zero vulnerabilities.

Receipts: `/tmp/cms-widget-{focused,focused-final,types,validation,packed}.log`,
`/tmp/cms-widget-production-audit.json` and the baseline pack JSON above. The disposable
consumer `/tmp/cms-studio-packed-c264j9ok` and baseline archive directory
`/tmp/cms-widget-baseline-0EYUPb` were removed and verified absent. All owned browser,
HTTP and validation processes ended; `git diff --check` passed.

This does not expose or integrate the separate custom-pane registry, introduce a new
plugin framework, or claim all CMS readiness complete. Native Safari retains its prior
blocked receipt and restored settings; deployed identity/CORS and external-provider
acceptance remain open. No deployment, release or push was performed.
