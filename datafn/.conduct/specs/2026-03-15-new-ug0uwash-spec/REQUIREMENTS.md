# Requirement Index
- IA-001
- IA-002
- IA-003
- LEG-001
- META-001
- TERM-001
- GUIDE-001
- CONCEPT-001
- START-001
- SETUP-001
- SHARE-001
- SYNC-001
- SEARCH-001
- DFQL-001
- CLI-001
- REF-001
- ADV-001
- RUNTIME-001
- EXAMPLE-001
- QA-001
- QA-002

## IA-001
- ID: IA-001
- Priority: P0
- Statement: The public docs root MUST become a newcomer-first landing experience at `/docs` that explains what DataFn is, why someone would use it, and where to start next.
- Rationale: The current root page is too sparse for first-time readers and does not function as a true entry point.
- Acceptance criteria:
  - `datafn/docs/content/docs/index.mdx` contains a plain-language product summary.
  - The root landing includes a clear “Start here” path into guides, DFQL, reference, and CLI.
  - The root landing no longer relies on “Select a section from the sidebar” as its main next step.
  - The root landing links to the primary example path for first-time readers.
- Test vectors: TV-IA-001, TV-START-001
- Notes: The architecture diagram MAY remain, but it cannot be the only orientation aid.

## IA-002
- ID: IA-002
- Priority: P0
- Statement: The Guides sidebar MUST use the exact newcomer-first section order defined in this spec and MUST remove public `migrations` and `use-cases` groups from the learning path.
- Rationale: Sidebar order is the first information architecture most readers encounter, so it must reflect learning order rather than historical accretion.
- Acceptance criteria:
  - `datafn/docs/content/docs/documentation/meta.json` uses the public title `Guides`.
  - Guides order is `index`, `concepts`, `client`, `server`, `sync`, `sharing`, `storage`, `plugins`, `database`, `advanced`.
  - `migrations` and `use-cases` are absent from public Guides navigation.
  - `datafn/docs/content/docs/documentation/concepts/meta.json` includes the new `glossary` page.
- Test vectors: TV-IA-002, TV-LEG-001
- Notes: Internal archival content MAY remain elsewhere in the repo, but not in the public sidebar.

## IA-003
- ID: IA-003
- Priority: P0
- Statement: Public sharing content MUST be consolidated into a dedicated `documentation/sharing` subtree and MUST no longer be split across concepts, sync, and use-cases sections.
- Rationale: Sharing is a core feature area and currently forces readers to stitch together multiple sections to understand one workflow.
- Acceptance criteria:
  - `datafn/docs/content/docs/documentation/sharing/meta.json` exists.
  - Public sharing pages exist at `documentation/sharing/overview.mdx`, `documentation/sharing/patterns.mdx`, and `documentation/sharing/sync-lifecycle.mdx`.
  - The old public paths for sharing concepts/sync/use-cases are removed from public navigation and internal cross-links are updated.
  - Sharing pages appear under the Guides sidebar in the defined order.
- Test vectors: TV-IA-002, TV-SHARE-001, TV-SHARE-002
- Notes: Because DataFn is unpublished, redirects are optional; updated internal links are mandatory.

## LEG-001
- ID: LEG-001
- Priority: P0
- Statement: Public docs MUST NOT contain migration, deprecation, backward-compatibility, or legacy guidance, including deprecated API variants and compatibility-window instructions.
- Rationale: The library is unpublished and unused, so public legacy material only adds confusion and teaches the wrong thing.
- Acceptance criteria:
  - `datafn/docs/content/docs/documentation/migrations/**` is removed from the public docs tree.
  - No public docs page mentions `shareWith.userId`, deprecated positional sharing calls, or legacy MiniSearch mode as valid public guidance.
  - No public docs page contains rollout/rollback/dual-read/dual-write migration instructions.
  - The docs audit fails with `DOCS_LEGACY_PUBLIC` if such content reappears.
- Test vectors: TV-LEG-001, TV-SEARCH-001, TV-QA-002
- Notes: Maintainer-only archival notes MAY live under `datafn/.conduct/**`.

## META-001
- ID: META-001
- Priority: P0
- Statement: Every public MDX page MUST declare the canonical frontmatter envelope with `title`, `description`, `audience`, and `applies_to`.
- Rationale: Consistent frontmatter is required to enforce audience-aware page standards across a large docs tree.
- Acceptance criteria:
  - Every public page under `datafn/docs/content/docs/**/*.mdx` includes all four fields.
  - `audience` is one of `landing`, `guide`, `concept`, or `reference`.
  - `applies_to` is one of `typescript`, `python`, or `both`.
  - The docs audit fails with `DOCS_FRONTMATTER_MISSING` or `DOCS_FRONTMATTER_INVALID` when fields are missing or invalid.
- Test vectors: TV-META-001, TV-QA-002
- Notes: Extra frontmatter fields are allowed, but these four are mandatory.

## TERM-001
- ID: TERM-001
- Priority: P0
- Statement: Public docs MUST use canonical terminology consistently and MUST provide a shared glossary page for foundational DataFn terms.
- Rationale: Outsider readers are slowed down more by inconsistent naming than by lack of detail.
- Acceptance criteria:
  - `datafn/docs/content/docs/documentation/concepts/glossary.mdx` exists.
  - The glossary defines core reader-facing terms such as namespace, actor, principal, guide, and reference.
  - Public page titles avoid leading with internal version labels such as `V2`.
  - Rewritten concept/sharing pages use plain-language phrasing before internal terms.
- Test vectors: TV-CONCEPT-001, TV-SHARE-001
- Notes: “SPV2” MAY appear once inside page bodies as an internal label, but not as the public page title.

## GUIDE-001
- ID: GUIDE-001
- Priority: P0
- Statement: Every public guide page MUST follow the guide template contract with overview, prerequisites, a shortest working example, and next steps.
- Rationale: Guide pages should help readers complete a task, not reverse-engineer structure from raw API material.
- Acceptance criteria:
  - Each `audience: guide` page includes `## Overview`.
  - Each `audience: guide` page includes `## Before You Start`.
  - Each `audience: guide` page includes a concrete working example section.
  - Each `audience: guide` page includes `## Next Steps`.
  - Each guide page links to its matching reference page when exhaustive detail lives elsewhere.
- Test vectors: TV-GUIDE-001, TV-SETUP-001, TV-REF-001
- Notes: Heading text MAY vary slightly only if the semantics remain clearly equivalent and are accepted by the audit/check strategy.

## CONCEPT-001
- ID: CONCEPT-001
- Priority: P0
- Statement: Every public concept page MUST explain the feature in plain language before internal mechanics and MUST reserve any “Under the hood” section for the end of the page.
- Rationale: Concept pages establish mental models; they should not begin like reference or implementation notes.
- Acceptance criteria:
  - Each `audience: concept` page includes an “In plain language” section or equivalent.
  - Each concept page includes a small narrative example.
  - Internal tables, indexes, or execution internals do not appear before the first explanation/example.
  - If an `Under the hood` section exists, it is the last major section.
- Test vectors: TV-CONCEPT-001, TV-SHARE-001
- Notes: This requirement applies especially to capabilities, namespaces, and sharing.

## START-001
- ID: START-001
- Priority: P0
- Statement: The public onboarding path MUST present typed client/server usage and example apps as the primary way to start with DataFn, with DFQL positioned as the underlying language rather than the first mandatory stop.
- Rationale: The project intent explicitly says typed SDK APIs are the public authoring surface and DFQL is the portable wire format.
- Acceptance criteria:
  - The root landing and `documentation/index.mdx` point first-time readers to the typed quickstart.
  - The onboarding path includes schema, server, client, and one successful query/mutation flow.
  - Onboarding pages link to the example apps for concrete follow-through.
  - DFQL is presented as important, but not as the only recommended first page for new readers.
- Test vectors: TV-START-001, TV-DFQL-001, TV-EXAMPLE-001
- Notes: This requirement is about teaching order, not hiding DFQL.

## SETUP-001
- ID: SETUP-001
- Priority: P0
- Statement: Client and server setup guides MUST prioritize a shortest working path and MUST offload exhaustive configuration matrices to the dedicated reference pages.
- Rationale: Setup guides currently blur task guidance with API reference, which makes the first setup experience heavier than necessary.
- Acceptance criteria:
  - `documentation/client/setup.mdx` starts with a shortest working client example before any exhaustive option matrix.
  - `documentation/server/setup.mdx` starts with a shortest working server example before any exhaustive option matrix.
  - Both setup guides link to `reference/client/config.mdx` or `reference/server/config.mdx` for full option coverage.
  - Full configuration reference remains available, but no longer dominates the guide page.
- Test vectors: TV-SETUP-001, TV-REF-001
- Notes: This requirement does not remove detail; it relocates it to the right page type.

## SHARE-001
- ID: SHARE-001
- Priority: P0
- Statement: Public sharing docs MUST be rewritten as a plain-language “Sharing” guide cluster that teaches namespace, actor, principal, grant scope, and sync effects through narrative examples before internal schemas or indexes.
- Rationale: Sharing is currently the clearest example of guide/reference mixing and internal jargon-first presentation.
- Acceptance criteria:
  - The public sharing overview page title is `Sharing`, not `Sharing V2`.
  - The overview explains namespace, actor, principal, visibility, and grant scope using plain language and narrative examples.
  - Internal table/index material is absent or moved to a late `Under the hood` section.
  - Sharing pages cross-link to capabilities, namespaces, and sharing sync behavior.
  - No public sharing page contains migration or legacy payload guidance.
- Test vectors: TV-SHARE-001, TV-SHARE-002, TV-LEG-001
- Notes: This requirement governs both structure and writing style.

## SYNC-001
- ID: SYNC-001
- Priority: P0
- Statement: Generic sync docs MUST explain clone, pull, push, hydration, clone-up, and cross-tab as user-visible workflows, while sharing-specific sync details MUST move into the dedicated sharing section.
- Rationale: Readers should be able to learn the generic sync model without mixing it with sharing-only edge cases.
- Acceptance criteria:
  - `documentation/sync/meta.json` no longer references sharing-specific sync content.
  - Sync pages explain what each sync operation is for and when a reader would use it.
  - Sharing-specific backfill/revoke behavior is documented under `documentation/sharing/sync-lifecycle.mdx`.
  - Sync pages remain comprehensive for generic offline-first behavior.
- Test vectors: TV-SYNC-001, TV-SHARE-002
- Notes: This does not reduce sharing coverage; it relocates it to a clearer cluster.

## SEARCH-001
- ID: SEARCH-001
- Priority: P0
- Statement: Public search docs MUST document only the current recommended provider-backed search path and MUST align the DFQL search, client search, and search-provider reference story.
- Rationale: Outsider readers should see one current search model, not a current-vs-legacy branching narrative.
- Acceptance criteria:
  - `dfql/search.mdx`, `documentation/plugins/client-search.mdx`, and `reference/core/search-provider.mdx` cross-link coherently.
  - Public docs do not recommend or describe legacy MiniSearch mode.
  - Search setup pages describe when to use top-level search provider setup vs client plugin configuration.
  - The docs audit treats legacy search guidance as an error.
- Test vectors: TV-SEARCH-001, TV-QA-002
- Notes: If obsolete compatibility paths still exist in code, they remain undocumented publicly.

## DFQL-001
- ID: DFQL-001
- Priority: P0
- Statement: The DFQL section MUST remain technically complete while becoming clearer about when readers should use DFQL directly and how it relates to the typed client/server surfaces.
- Rationale: DFQL is foundational, but beginners need positioning and canonical envelopes more than raw term density.
- Acceptance criteria:
  - `dfql/index.mdx` explains DFQL as the underlying language and wire/reference format.
  - DFQL query, mutation, transaction, and search pages use canonical envelopes and minimal examples.
  - DFQL pages avoid teaching deprecated sharing payloads or compatibility aliases.
  - DFQL pages link back to the relevant guide pages where practical.
- Test vectors: TV-DFQL-001, TV-LEG-001
- Notes: This requirement covers both the landing page and operation pages.

## CLI-001
- ID: CLI-001
- Priority: P0
- Statement: The CLI section MUST be task-first, accurate to current commands, and clearly connected to the guide pages that rely on CLI output.
- Rationale: CLI docs are most useful when they tell readers what to run, what it produces, and where that output is used next.
- Acceptance criteria:
  - `cli/index.mdx` explains when the CLI is needed.
  - `generate`, `validate`, `type-codegen`, and `drizzle-codegen` pages remain accurate to current command surfaces.
  - CLI pages show input/output expectations for the task being documented.
  - Guide pages that depend on CLI output link to the relevant CLI docs.
- Test vectors: TV-CLI-001, TV-BUILD-001
- Notes: This requirement is about clarity and accuracy, not introducing new CLI features.

## REF-001
- ID: REF-001
- Priority: P0
- Statement: Every public reference page MUST include a plain-language summary, a minimal example, and at least one related-guide link while preserving exhaustive API detail.
- Rationale: Reference pages are currently inconsistent in how much orientation they provide before raw types or internals.
- Acceptance criteria:
  - Each reference page begins with a one-paragraph summary in plain language.
  - Each reference page contains at least one minimal usage example.
  - Each reference page links back to one or more relevant guide pages.
  - Exhaustive type/member coverage remains present after the rewrite.
- Test vectors: TV-REF-001, TV-META-001
- Notes: This applies to client, core, and server reference pages.

## ADV-001
- ID: ADV-001
- Priority: P0
- Statement: Storage, plugins, database, and advanced guide pages MUST be rewritten to lead with decisions and tasks rather than raw interfaces, internal classes, or implementation-first exposition.
- Rationale: These clusters are important, but their current openings often read like source commentary instead of public docs.
- Acceptance criteria:
  - `documentation/database/adapters.mdx` opens with adapter choice and usage, not a raw interface dump.
  - `documentation/plugins/overview.mdx` opens with when/why to use plugins, not hook internals only.
  - `documentation/advanced/change-tracking.mdx` and similar pages clearly frame reader value before internal services/tables.
  - Any retained internals appear late or are linked to reference pages.
- Test vectors: TV-ADV-001, TV-GUIDE-001
- Notes: This requirement covers the full clusters, not just the named examples.

## RUNTIME-001
- ID: RUNTIME-001
- Priority: P0
- Statement: Every page with TypeScript/Python or package-support differences MUST show an applicability note near the top and MUST state unsupported combinations explicitly.
- Rationale: Mixed-runtime docs become misleading when support differences are buried deep in the page.
- Acceptance criteria:
  - Mixed-support pages include a near-top runtime/applicability note.
  - TypeScript-only or Python-only features are labeled clearly.
  - Unsupported routes/features are stated explicitly where relevant.
  - The docs audit fails with `DOCS_RUNTIME_SCOPE_MISSING` when required applicability notes are absent.
- Test vectors: TV-RUNTIME-001, TV-QA-002
- Notes: This is especially important for server routes/setup and framework/runtime-dependent pages.

## EXAMPLE-001
- ID: EXAMPLE-001
- Priority: P0
- Statement: Public onboarding and feature guides MUST link to real example apps, and public code snippets MUST be traceable to actual repo examples, tests, or maintained snippet sources.
- Rationale: Beginner trust increases when examples are real and verifiable instead of aspirational.
- Acceptance criteria:
  - Onboarding guides link to the relevant example apps under `datafn/examples`.
  - Sharing docs link to the dedicated sharing example app.
  - Snippet provenance is documented or auditable for public code examples.
  - The docs audit fails with `DOCS_SNIPPET_SOURCE_MISSING` when a governed snippet lacks provenance.
- Test vectors: TV-EXAMPLE-001, TV-QA-002
- Notes: Snippet provenance can use examples, tests, or dedicated maintained snippet sources.

## QA-001
- ID: QA-001
- Priority: P0
- Statement: The docs package MUST provide a deterministic local audit command with the stable error codes defined in the spec and MUST fail on any public-docs rule violation.
- Rationale: A rewrite this broad will regress unless its standards are executable and repeatable.
- Acceptance criteria:
  - `npm --prefix datafn/docs run docs:audit` exists.
  - Audit output uses the documented result envelope and stable error codes.
  - Findings are sorted deterministically.
  - Audit exits non-zero when error-severity findings exist.
- Test vectors: TV-QA-001, TV-QA-002
- Notes: Warnings are optional; error handling is mandatory.

## QA-002
- ID: QA-002
- Priority: P0
- Statement: The final docs rewrite MUST pass a local build plus navigation/content verification covering public section order, moved pages, and absence of banned legacy content.
- Rationale: The docs must not only read better in source; they must render and navigate correctly in the actual site.
- Acceptance criteria:
  - `npm --prefix datafn/docs run build` succeeds.
  - Public sidebar navigation renders the target section order.
  - Moved sharing pages render at their new public locations.
  - No banned legacy content is found by the docs audit.
- Test vectors: TV-BUILD-001, TV-QA-001, TV-QA-002
- Notes: Manual spot checks MAY supplement the build, but they do not replace it.
