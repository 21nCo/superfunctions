## TV-IA-001
Description:
Root landing is a real newcomer homepage instead of a sparse architecture splash.

Input:
```json
{
  "route": "/docs",
  "pagePath": "datafn/docs/content/docs/index.mdx",
  "requiredSignals": [
    "What DataFn is",
    "Start here",
    "Guides",
    "DFQL",
    "Reference",
    "CLI"
  ],
  "forbiddenSignals": [
    "Select a section from the sidebar"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "checks": [
    "landing-summary-present",
    "start-path-present",
    "top-level-links-present",
    "forbidden-copy-absent"
  ]
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_NAV_INVALID",
    "message": "Root landing is missing a newcomer start path or still uses placeholder sidebar-only guidance."
  }
}
```

## TV-IA-002
Description:
Guides navigation is reordered correctly and sharing is its own public subtree.

Input:
```json
{
  "metaPath": "datafn/docs/content/docs/documentation/meta.json",
  "expectedTitle": "Guides",
  "expectedPages": [
    "index",
    "concepts",
    "client",
    "server",
    "sync",
    "sharing",
    "storage",
    "plugins",
    "database",
    "advanced"
  ],
  "forbiddenPages": [
    "migrations",
    "use-cases"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "title": "Guides",
  "pagesMatch": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_NAV_INVALID",
    "message": "Guides sidebar order or group membership does not match the public information architecture."
  }
}
```

## TV-LEG-001
Description:
Public docs contain no migration/deprecation/legacy guidance.

Input:
```json
{
  "scanRoot": "datafn/docs/content/docs",
  "forbiddenPatterns": [
    "shareWith.userId",
    "deprecated positional sharing",
    "legacy MiniSearch",
    "dual-read",
    "dual-write",
    "rollback",
    "compatibility window"
  ],
  "forbiddenPaths": [
    "datafn/docs/content/docs/documentation/migrations/meta.json",
    "datafn/docs/content/docs/documentation/migrations/spv2.mdx"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "matches": []
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_LEGACY_PUBLIC",
    "message": "Public docs still contain legacy or migration guidance."
  }
}
```

## TV-META-001
Description:
Every public MDX page has the canonical frontmatter envelope.

Input:
```json
{
  "pagePath": "datafn/docs/content/docs/documentation/client/setup.mdx",
  "requiredFrontmatter": {
    "title": "string",
    "description": "string",
    "audience": ["landing", "guide", "concept", "reference"],
    "applies_to": ["typescript", "python", "both"]
  }
}
```

Expected output:
```json
{
  "ok": true,
  "frontmatterValid": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_FRONTMATTER_MISSING",
    "message": "Required frontmatter fields are missing or invalid."
  }
}
```

## TV-GUIDE-001
Description:
Guide pages follow the guide template contract.

Input:
```json
{
  "pagePath": "datafn/docs/content/docs/documentation/storage/overview.mdx",
  "audience": "guide",
  "requiredSections": [
    "Overview",
    "Before You Start",
    "Example",
    "Next Steps"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "missingSections": []
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_SECTION_MISSING",
    "message": "Guide page is missing one or more required task-oriented sections."
  }
}
```

## TV-CONCEPT-001
Description:
Concept pages explain plain language first and push internals to the end.

Input:
```json
{
  "pagePath": "datafn/docs/content/docs/documentation/concepts/multi-tenancy.mdx",
  "audience": "concept",
  "requiredSections": [
    "In Plain Language",
    "Why It Exists",
    "Example"
  ],
  "internalSignals": [
    "__ns",
    "__datafn_",
    "internal table",
    "index"
  ],
  "rule": "internal-signals-must-not-appear-before-first-example"
}
```

Expected output:
```json
{
  "ok": true,
  "internalBeforeExample": false
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_GUIDE_REFERENCE_MIX",
    "message": "Concept page introduces internals before the reader gets a plain-language model."
  }
}
```

## TV-START-001
Description:
The getting-started path teaches typed APIs first and links to real examples.

Input:
```json
{
  "pagePath": "datafn/docs/content/docs/documentation/index.mdx",
  "requiredSignals": [
    "define a schema",
    "create a server",
    "create a client",
    "query",
    "mutate",
    "example app"
  ],
  "requiredLinks": [
    "/docs/documentation/client/setup",
    "/docs/documentation/server/setup"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "typedPathFirst": true,
  "exampleLinksPresent": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_SECTION_MISSING",
    "message": "Getting Started does not provide a coherent typed client/server onboarding path."
  }
}
```

## TV-SETUP-001
Description:
Client and server setup pages lead with a shortest working path and link to reference for exhaustive options.

Input:
```json
{
  "pages": [
    "datafn/docs/content/docs/documentation/client/setup.mdx",
    "datafn/docs/content/docs/documentation/server/setup.mdx"
  ],
  "requiredSignals": [
    "shortest working example",
    "reference/client/config",
    "reference/server/config"
  ],
  "forbiddenLead": [
    "full configuration table before first runnable example"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "quickstartLead": true,
  "referenceLinksPresent": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_GUIDE_REFERENCE_MIX",
    "message": "Setup guide still leads with exhaustive reference detail instead of a working path."
  }
}
```

## TV-SHARE-001
Description:
The public sharing overview page is plain-language, renamed, and narrative-first.

Input:
```json
{
  "pagePath": "datafn/docs/content/docs/documentation/sharing/overview.mdx",
  "title": "Sharing",
  "requiredSignals": [
    "namespace",
    "actor",
    "principal",
    "grant scope",
    "example"
  ],
  "forbiddenSignals": [
    "Sharing V2",
    "migration",
    "compatibility window"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "titleMatches": true,
  "plainLanguageLead": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_LEGACY_PUBLIC",
    "message": "Sharing overview still exposes internal versioning or legacy guidance."
  }
}
```

## TV-SHARE-002
Description:
Sharing patterns and sharing sync lifecycle live under the sharing cluster and are linked together.

Input:
```json
{
  "requiredPaths": [
    "datafn/docs/content/docs/documentation/sharing/patterns.mdx",
    "datafn/docs/content/docs/documentation/sharing/sync-lifecycle.mdx"
  ],
  "requiredLinks": [
    "/docs/documentation/sharing/overview",
    "/docs/documentation/sharing/patterns",
    "/docs/documentation/sharing/sync-lifecycle"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "pathsExist": true,
  "crossLinksPresent": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_NAV_INVALID",
    "message": "Sharing pages are still scattered or missing from the dedicated sharing cluster."
  }
}
```

## TV-SYNC-001
Description:
Generic sync docs explain user workflows and do not keep sharing-only lifecycle pages in the sync subtree.

Input:
```json
{
  "syncMetaPath": "datafn/docs/content/docs/documentation/sync/meta.json",
  "expectedPages": [
    "overview",
    "offline-first",
    "clone",
    "pull-push",
    "hydration",
    "clone-up",
    "cross-tab"
  ],
  "forbiddenPages": [
    "sharing-sync-lifecycle"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "genericSyncOnly": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_NAV_INVALID",
    "message": "Generic sync navigation still mixes sharing-specific lifecycle content."
  }
}
```

## TV-SEARCH-001
Description:
Public search docs present one current provider-backed model and no legacy MiniSearch branch.

Input:
```json
{
  "paths": [
    "datafn/docs/content/docs/dfql/search.mdx",
    "datafn/docs/content/docs/documentation/plugins/client-search.mdx",
    "datafn/docs/content/docs/reference/core/search-provider.mdx"
  ],
  "requiredSignals": [
    "provider-backed",
    "searchProvider",
    "related links"
  ],
  "forbiddenSignals": [
    "legacy MiniSearch",
    "deprecated MiniSearch"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "singleRecommendedModel": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_LEGACY_PUBLIC",
    "message": "Search docs still document or recommend a legacy search path."
  }
}
```

## TV-DFQL-001
Description:
The DFQL section is positioned as underlying language/reference rather than the only first-stop onboarding path.

Input:
```json
{
  "pagePath": "datafn/docs/content/docs/dfql/index.mdx",
  "requiredSignals": [
    "underlying language",
    "typed client APIs",
    "wire format",
    "query",
    "mutation",
    "transaction"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "positioningClear": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_SECTION_MISSING",
    "message": "DFQL overview does not explain how DFQL relates to the typed public APIs."
  }
}
```

## TV-CLI-001
Description:
CLI docs are task-first and accurate to the current commands.

Input:
```json
{
  "paths": [
    "datafn/docs/content/docs/cli/index.mdx",
    "datafn/docs/content/docs/cli/generate.mdx",
    "datafn/docs/content/docs/cli/validate.mdx",
    "datafn/docs/content/docs/cli/type-codegen.mdx",
    "datafn/docs/content/docs/cli/drizzle-codegen.mdx"
  ],
  "requiredSignals": [
    "what this command does",
    "usage",
    "output"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "taskFramingPresent": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_SECTION_MISSING",
    "message": "CLI docs do not explain task intent or expected output clearly enough."
  }
}
```

## TV-REF-001
Description:
Reference pages include a plain-language summary, minimal example, and related guide links.

Input:
```json
{
  "pagePath": "datafn/docs/content/docs/reference/client/config.mdx",
  "requiredSignals": [
    "plain-language summary",
    "example",
    "related guide"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "referenceOrientationPresent": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_RELATED_LINK_MISSING",
    "message": "Reference page is missing orientation or a guide backlink."
  }
}
```

## TV-ADV-001
Description:
Advanced/storage/plugins/database guides lead with decisions/tasks instead of raw interfaces or internal services.

Input:
```json
{
  "paths": [
    "datafn/docs/content/docs/documentation/database/adapters.mdx",
    "datafn/docs/content/docs/documentation/plugins/overview.mdx",
    "datafn/docs/content/docs/documentation/advanced/change-tracking.mdx"
  ],
  "forbiddenLeadSignals": [
    "interface Adapter",
    "ChangeTrackingService",
    "hook runner internals"
  ],
  "requiredLeadSignals": [
    "when to use",
    "choose",
    "overview"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "decisionFirstLead": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_GUIDE_REFERENCE_MIX",
    "message": "Guide page still opens with interface or implementation detail instead of reader decisions."
  }
}
```

## TV-RUNTIME-001
Description:
Pages with runtime differences show a near-top applicability note.

Input:
```json
{
  "pagePath": "datafn/docs/content/docs/documentation/server/routes.mdx",
  "requiredSignals": [
    "applies to",
    "TypeScript",
    "Python",
    "not implemented"
  ],
  "placementRule": "before-first-major-example"
}
```

Expected output:
```json
{
  "ok": true,
  "applicabilityVisible": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_RUNTIME_SCOPE_MISSING",
    "message": "Runtime applicability is missing or buried too late in the page."
  }
}
```

## TV-EXAMPLE-001
Description:
Public snippets and onboarding pages link to and derive from real example sources.

Input:
```json
{
  "governedPages": [
    "datafn/docs/content/docs/documentation/index.mdx",
    "datafn/docs/content/docs/documentation/sharing/overview.mdx"
  ],
  "requiredExampleLinks": [
    "datafn/examples/todo-app",
    "datafn/examples/sharing-app"
  ],
  "requiredSnippetProvenance": true
}
```

Expected output:
```json
{
  "ok": true,
  "exampleLinksPresent": true,
  "snippetSourcesTracked": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_SNIPPET_SOURCE_MISSING",
    "message": "Public snippet or example link is not traceable to a maintained repo source."
  }
}
```

## TV-QA-001
Description:
Docs audit passes cleanly with deterministic success output.

Input:
```json
{
  "command": "npm --prefix datafn/docs run docs:audit"
}
```

Expected output:
```json
{
  "ok": true,
  "summary": {
    "errorCount": 0
  },
  "findings": []
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_AUDIT_FAILED",
    "message": "docs:audit exited non-zero despite expected-clean public docs."
  }
}
```

## TV-QA-002
Description:
Docs audit returns stable error codes and deterministic sorting when failures exist.

Input:
```json
{
  "fixture": {
    "pagePath": "datafn/docs/content/docs/documentation/sharing/overview.mdx",
    "insertedProblems": [
      "missing applies_to frontmatter",
      "legacy MiniSearch string"
    ]
  }
}
```

Expected output:
```json
{
  "ok": false,
  "findings": [
    {
      "code": "DOCS_FRONTMATTER_MISSING",
      "severity": "error"
    },
    {
      "code": "DOCS_LEGACY_PUBLIC",
      "severity": "error"
    }
  ]
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_AUDIT_UNSTABLE",
    "message": "docs:audit returned undocumented or nondeterministically ordered findings."
  }
}
```

## TV-BUILD-001
Description:
The docs build succeeds and moved public pages render at their new locations.

Input:
```json
{
  "commands": [
    "npm --prefix datafn/docs run build",
    "npm --prefix datafn/docs run dev"
  ],
  "routes": [
    "/docs",
    "/docs/documentation",
    "/docs/documentation/sharing/overview",
    "/docs/dfql",
    "/docs/reference",
    "/docs/cli"
  ]
}
```

Expected output:
```json
{
  "ok": true,
  "buildSucceeded": true,
  "routesRendered": true
}
```

Negative variant(s):
```json
{
  "ok": false,
  "error": {
    "code": "DOCS_BROKEN_LINK",
    "message": "Build or route verification failed after the docs restructure."
  }
}
```
