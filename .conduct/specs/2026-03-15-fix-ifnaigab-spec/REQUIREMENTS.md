# Requirement IDs

- DOCS-001
- DOCS-002
- DOCS-003
- DOCS-004
- DOCS-005
- DOCS-006
- DOCS-007
- DOCS-008
- DOCS-009
- QA-001
- QA-002

## DOCS-001

- **Priority**: P0
- **Statement**: The root docs site MUST present itself as `Superfunctions` and provide a beginner-friendly introduction that explains the mission, audience, and scope of the root docs site.
- **Rationale**: The current title and landing copy read like internal scaffolding rather than a public-facing docs entry point.
- **Acceptance criteria**:
  - `docs/app/layout.config.tsx` exposes a site title of `Superfunctions`.
  - The `/docs` page title is not `Shared Docs`, `Superfunctions Shared`, or `Shared Packages`.
  - `/docs` includes sections for mission, audience, ecosystem context, and clear next steps.
  - No top-level site copy uses repo-internal framing as the primary label for the site.
- **Test vectors**: TV-DOCS-001, TV-DOCS-002
- **Notes**: Mentioning “shared packages” inside explanatory prose is allowed when used descriptively, but it must not be the site title or dominant nav concept.

## DOCS-002

- **Priority**: P0
- **Statement**: The root docs sidebar MUST use the exact user-facing category taxonomy and ordering defined in this spec instead of generic “shared” groupings.
- **Rationale**: Readers need categories that match their intent and package scope, not repo implementation history.
- **Acceptance criteria**:
  - The top-level sidebar order is exactly: `Start Here`, `Authentication & OAuth`, `HTTP & Framework Adapters`, `Middleware & Runtime`, `Data & Storage`, `Python Integrations`, `Tooling`.
  - No active top-level nav group is named `Shared`, `Shared Packages`, `migration`, `migrations`, or `operations`.
  - Every shared package appears exactly once in the package catalog and exactly once in the page tree.
  - Package ordering within categories is deterministic and documented in the catalog.
- **Test vectors**: TV-DOCS-002, TV-DOCS-009
- **Notes**: This requirement covers the navigation labels and the underlying grouping model.

## DOCS-003

- **Priority**: P0
- **Statement**: The root docs MUST include comprehensive Start Here and ecosystem pages that explain the Superfunctions ecosystem and link readers to the appropriate function-specific docs entry points.
- **Rationale**: The root site should orient beginners and explain where to go for package docs versus function docs.
- **Acceptance criteria**:
  - `/docs/getting-started`, `/docs/choosing-packages`, and `/docs/ecosystem` exist.
  - `/docs/ecosystem` includes entries for every top-level function listed in `AGENTS.md`.
  - Each ecosystem entry includes a one-line purpose summary and a public link target.
  - The Start Here pages explicitly clarify that the root docs focus on shared packages and ecosystem orientation.
- **Test vectors**: TV-DOCS-001, TV-DOCS-003
- **Notes**: Links may target dedicated docs apps, repo docs folders, or README/SPEC landing points depending on what exists.

## DOCS-004

- **Priority**: P0
- **Statement**: Each top-level package category MUST have an overview page that explains the category scope, package relationships, chooser guidance, and common compositions.
- **Rationale**: Category pages are the bridge between broad ecosystem orientation and detailed package pages.
- **Acceptance criteria**:
  - Overview pages exist for `authentication`, `http`, `middleware-runtime`, `data-storage`, `python`, and `tooling`.
  - Each overview page contains the required section headings defined in `SPEC.md`.
  - Each overview page contains a package map or equivalent chooser artifact.
  - Overview pages cross-link to their package pages and at least one adjacent category.
- **Test vectors**: TV-DOCS-004, TV-DOCS-008
- **Notes**: The package map may be a table, checklist, or matrix so long as it is concrete and readable.

## DOCS-005

- **Priority**: P0
- **Statement**: Every shared package page MUST be rewritten to meet the required page contract, minimum content depth, and cross-linking standards defined in this spec.
- **Rationale**: The current package pages are mostly placeholders that satisfy file coverage but do not teach real usage.
- **Acceptance criteria**:
  - Every package page contains the exact required headings from `SPEC.md`.
  - TypeScript pages meet the minimum prose and code-sample thresholds.
  - Python pages meet the minimum prose and code-sample thresholds.
  - Every package page includes at least two related-package links.
  - Generic placeholder prose is absent.
- **Test vectors**: TV-DOCS-005, TV-DOCS-006, TV-QA-001
- **Notes**: This requirement applies to all routes generated from the package catalog, including `docs-theme`, storage adapters, and Python integration pages.

## DOCS-006

- **Priority**: P0
- **Statement**: Package page examples MUST be outside-world focused and valid for external library authors or application developers without assuming monorepo-only context.
- **Rationale**: The user wants the docs written for the outside world, not only for internal package maintainers.
- **Acceptance criteria**:
  - Examples use real package imports from the shared packages that exist in the repo.
  - No example uses monorepo-relative paths, internal-only aliases, or nonexistent package names.
  - Each package page includes at least one example for an external library author or application developer.
  - Internal Superfunctions usage MAY appear, but only as secondary context.
- **Test vectors**: TV-DOCS-006, TV-QA-001
- **Notes**: The example persona may vary by package, but the page must make that persona explicit.

## DOCS-007

- **Priority**: P1
- **Statement**: Category content MUST include package-selection guidance specific to that category, especially for the Authentication & OAuth, HTTP, Data & Storage, and Python sections.
- **Rationale**: Better grouping is only useful if readers can understand how sibling packages differ and compose.
- **Acceptance criteria**:
  - Authentication & OAuth docs explain low-level versus high-level OAuth package roles.
  - HTTP docs include an adapter selection matrix or chooser.
  - Data & Storage docs include a storage-provider chooser and explain the relationship between `db`, `storage`, and `files`.
  - Python docs explain how Python integrations relate to the shared concepts documented elsewhere.
- **Test vectors**: TV-DOCS-007, TV-DOCS-008
- **Notes**: The chooser artifact may live on overview pages, package pages, or both, but it must be easy to find.

## DOCS-008

- **Priority**: P0
- **Statement**: The completed root docs MUST remove migration, legacy, deprecation, and release-note content from active navigation and core page flows.
- **Rationale**: The packages are not published yet, so those sections add noise and send the wrong signal.
- **Acceptance criteria**:
  - No active nav item points to `migration`, `migrations`, or release-note/deprecation pages.
  - No package page contains a migration, legacy, or deprecation section.
  - Old files MAY remain temporarily in the repo during implementation, but they MUST NOT remain in the completed page tree or internal link graph.
- **Test vectors**: TV-DOCS-002, TV-DOCS-009
- **Notes**: This requirement is about the user-facing finished state, not intermediate implementation commits.

## DOCS-009

- **Priority**: P1
- **Statement**: The docs site MUST maintain machine-readable package and ecosystem catalogs that define category assignment, ordering, and validation inputs.
- **Rationale**: A catalog-driven structure prevents future drift between packages, nav, and docs quality checks.
- **Acceptance criteria**:
  - A package catalog file exists and covers every shared package page in scope.
  - An ecosystem catalog file exists and covers every top-level Superfunction in scope.
  - Validation scripts read from the catalogs instead of hardcoding scattered lists in multiple places.
  - Catalog ordering is deterministic.
- **Test vectors**: TV-DOCS-009, TV-QA-001
- **Notes**: The exact file names may vary, but the data model and purpose may not.

## QA-001

- **Priority**: P0
- **Statement**: The docs workspace MUST add a content-quality validation step that rejects thin, mis-grouped, placeholder-heavy, or structurally incomplete docs pages.
- **Rationale**: Existing checks allow poor pages to pass as long as the file exists and imports are valid.
- **Acceptance criteria**:
  - A content-quality script exists in `docs/scripts/`.
  - The script validates required pages, required headings, category assignment, minimum prose length, minimum code examples, banned placeholder phrases, and example validity.
  - The script exits non-zero with deterministic JSON when validation fails.
  - The script passes with empty problem arrays when docs satisfy the content contract.
- **Test vectors**: TV-QA-001
- **Notes**: The script may replace or absorb the current coverage script so long as the new checks are strictly stronger.

## QA-002

- **Priority**: P0
- **Statement**: The docs workspace MUST expose a complete local verification suite covering build, navigation/catalog structure, content quality, snippets, and links.
- **Rationale**: The docs need an implementation-time safety net, not just a final manual readthrough.
- **Acceptance criteria**:
  - `docs/package.json` includes scripts for build, content validation, snippet validation, and link validation.
  - The package verification commands are documented in the plan and phase files.
  - The completed docs changes pass the local verification suite.
  - Failure outputs use the documented error codes.
- **Test vectors**: TV-QA-001, TV-QA-002
- **Notes**: Script names may be `check:catalog`, `check:content`, `check:snippets`, and `check:links`, or equivalent documented names.
