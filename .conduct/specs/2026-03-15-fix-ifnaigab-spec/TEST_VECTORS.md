# TV-DOCS-001

- **Description**: Root docs branding and intro page are external-facing and beginner-friendly.
- **Input**:
```json
{
  "layoutTitle": "Superfunctions",
  "rootPage": {
    "title": "Superfunctions",
    "headings": [
      "## What Superfunctions Is",
      "## Who These Docs Are For",
      "## How the Ecosystem Fits Together",
      "## Start With These Packages"
    ]
  }
}
```
- **Expected output**:
```json
{
  "ok": true,
  "error": null
}
```
- **Negative variant(s)**:
```json
{
  "layoutTitle": "Superfunctions Shared",
  "rootPage": {
    "title": "Shared Docs",
    "headings": ["## Sections"]
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_BRANDING_INVALID", "message": "Root docs identity is still scaffold-oriented." }
}
```

# TV-DOCS-002

- **Description**: Top-level navigation uses the exact category taxonomy and excludes legacy docs buckets.
- **Input**:
```json
{
  "topLevelSections": [
    "Start Here",
    "Authentication & OAuth",
    "HTTP & Framework Adapters",
    "Middleware & Runtime",
    "Data & Storage",
    "Python Integrations",
    "Tooling"
  ]
}
```
- **Expected output**:
```json
{
  "ok": true,
  "error": null
}
```
- **Negative variant(s)**:
```json
{
  "topLevelSections": [
    "Shared Packages",
    "Architecture",
    "Migrations",
    "Operations"
  ]
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_NAV_INVALID", "message": "Top-level docs taxonomy does not match required user-facing grouping." }
}
```

# TV-DOCS-003

- **Description**: Ecosystem page includes the required function catalog and public doc targets.
- **Input**:
```json
{
  "ecosystemEntries": [
    "authfn",
    "cachefn",
    "drawfn",
    "plugfn",
    "searchfn",
    "secfn",
    "testfn",
    "botfn",
    "hostfn",
    "uifn",
    "watchfn",
    "billfn",
    "browsefn",
    "chartfn",
    "datafn",
    "docsfn",
    "filefn",
    "flowfn",
    "iconfn",
    "logfn",
    "sendfn"
  ]
}
```
- **Expected output**:
```json
{
  "ok": true,
  "missing": []
}
```
- **Negative variant(s)**:
```json
{
  "ecosystemEntries": [
    "datafn",
    "searchfn"
  ]
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_ECOSYSTEM_INCOMPLETE", "message": "Root docs ecosystem page is missing required function entries." },
  "missing": ["authfn", "plugfn", "hostfn"]
}
```

# TV-DOCS-004

- **Description**: Category overview page satisfies the overview-page contract.
- **Input**:
```json
{
  "path": "docs/content/docs/http/index.mdx",
  "headings": [
    "## What This Category Covers",
    "## Package Map",
    "## How To Choose",
    "## Common Compositions",
    "## Related Categories"
  ],
  "proseWords": 412
}
```
- **Expected output**:
```json
{
  "ok": true,
  "missingSections": []
}
```
- **Negative variant(s)**:
```json
{
  "path": "docs/content/docs/http/index.mdx",
  "headings": [
    "## Quick Start"
  ],
  "proseWords": 78
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_CATEGORY_OVERVIEW_INCOMPLETE", "message": "Category overview page is missing required guidance sections." },
  "missingSections": [
    "## What This Category Covers",
    "## Package Map",
    "## How To Choose",
    "## Common Compositions",
    "## Related Categories"
  ]
}
```

# TV-DOCS-005

- **Description**: A TypeScript package page satisfies the required content contract.
- **Input**:
```json
{
  "path": "docs/content/docs/authentication/oauth-flow.mdx",
  "headings": [
    "## What It Is",
    "## When To Use It",
    "## Install",
    "## Quick Start",
    "## Core Concepts",
    "## Real-World Example",
    "## Related Packages",
    "## Troubleshooting"
  ],
  "proseWords": 527,
  "codeFences": ["bash", "ts", "ts"]
}
```
- **Expected output**:
```json
{
  "ok": true,
  "error": null
}
```
- **Negative variant(s)**:
```json
{
  "path": "docs/content/docs/authentication/oauth-flow.mdx",
  "headings": [
    "## Quick Start",
    "## Production Example",
    "## Troubleshooting"
  ],
  "proseWords": 109,
  "codeFences": ["bash", "ts"]
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_PACKAGE_PAGE_INCOMPLETE", "message": "Package page does not meet the required structure or depth." }
}
```

# TV-DOCS-006

- **Description**: A Python package page satisfies the required content contract with real Python examples.
- **Input**:
```json
{
  "path": "docs/content/docs/python/python-fastapi.mdx",
  "headings": [
    "## What It Is",
    "## When To Use It",
    "## Install",
    "## Quick Start",
    "## Core Concepts",
    "## Real-World Example",
    "## Related Packages",
    "## Troubleshooting"
  ],
  "proseWords": 344,
  "codeFences": ["bash", "python", "python"]
}
```
- **Expected output**:
```json
{
  "ok": true,
  "error": null
}
```
- **Negative variant(s)**:
```json
{
  "path": "docs/content/docs/python/python-fastapi.mdx",
  "headings": [
    "## Quick Start",
    "## Troubleshooting"
  ],
  "proseWords": 88,
  "codeFences": ["bash", "ts"]
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_PACKAGE_PAGE_INCOMPLETE", "message": "Python package page is missing required sections or Python-native examples." }
}
```

# TV-DOCS-007

- **Description**: Package examples are valid for the outside world and use only real public package imports.
- **Input**:
```json
{
  "path": "docs/content/docs/http/http.mdx",
  "imports": [
    "@superfunctions/http",
    "@superfunctions/http-express"
  ],
  "containsMonorepoPaths": false,
  "audience": "external-library-author"
}
```
- **Expected output**:
```json
{
  "ok": true,
  "invalidExamples": []
}
```
- **Negative variant(s)**:
```json
{
  "path": "docs/content/docs/data-storage/db.mdx",
  "imports": [
    "@superfunctions/authFn",
    "../../packages/db/src/index"
  ],
  "containsMonorepoPaths": true,
  "audience": "internal-maintainer"
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_EXAMPLE_INVALID", "message": "Example is not valid for external readers." },
  "invalidExamples": [
    "nonexistent package import",
    "monorepo-only path",
    "wrong primary audience"
  ]
}
```

# TV-DOCS-008

- **Description**: Category-specific chooser content exists for sibling packages that readers could confuse.
- **Input**:
```json
{
  "pages": [
    "/docs/authentication",
    "/docs/http",
    "/docs/data-storage",
    "/docs/python"
  ],
  "chooserArtifacts": {
    "authentication": true,
    "http": true,
    "data-storage": true,
    "python": true
  }
}
```
- **Expected output**:
```json
{
  "ok": true,
  "missingChoosers": []
}
```
- **Negative variant(s)**:
```json
{
  "pages": [
    "/docs/authentication",
    "/docs/http"
  ],
  "chooserArtifacts": {
    "authentication": false,
    "http": false
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_CATEGORY_OVERVIEW_INCOMPLETE", "message": "Category chooser guidance is missing." },
  "missingChoosers": ["authentication", "http"]
}
```

# TV-DOCS-009

- **Description**: Removed-scope docs sections are absent from the active root docs surface.
- **Input**:
```json
{
  "activeNavRoutes": [
    "/docs",
    "/docs/getting-started",
    "/docs/ecosystem",
    "/docs/authentication",
    "/docs/http",
    "/docs/data-storage"
  ],
  "activePageHeadings": [
    "Superfunctions",
    "Authentication & OAuth"
  ]
}
```
- **Expected output**:
```json
{
  "ok": true,
  "forbiddenRoutesPresent": []
}
```
- **Negative variant(s)**:
```json
{
  "activeNavRoutes": [
    "/docs/shared",
    "/docs/migrations",
    "/docs/operations/release-notes-and-deprecations"
  ],
  "activePageHeadings": [
    "Shared Packages",
    "Migrations"
  ]
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_SCOPE_VIOLATION", "message": "User-deferred migration or internal docs sections are still exposed." }
}
```

# TV-DOCS-010

- **Description**: Package and ecosystem catalogs are complete and deterministic.
- **Input**:
```json
{
  "packageCatalogCount": 27,
  "packageCatalogHasDuplicates": false,
  "ecosystemCatalogCount": 21,
  "categories": [
    "authentication",
    "http",
    "middleware-runtime",
    "data-storage",
    "python",
    "tooling"
  ]
}
```
- **Expected output**:
```json
{
  "ok": true,
  "error": null
}
```
- **Negative variant(s)**:
```json
{
  "packageCatalogCount": 24,
  "packageCatalogHasDuplicates": true,
  "ecosystemCatalogCount": 5,
  "categories": [
    "shared"
  ]
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_CATALOG_INVALID", "message": "Catalog coverage or ordering is incomplete." }
}
```

# TV-QA-001

- **Description**: Content-quality checker rejects placeholder-heavy and incomplete docs.
- **Input**:
```json
{
  "pages": [
    {
      "path": "docs/content/docs/authentication/auth.mdx",
      "proseWords": 92,
      "headings": ["## Quick Start", "## Troubleshooting"],
      "placeholderHits": ["Reference and usage guidance"],
      "imports": ["@superfunctions/auth"]
    }
  ]
}
```
- **Expected output**:
```json
{
  "ok": false,
  "error": { "code": "DOCS_CONTENT_INVALID" },
  "thinPages": [
    {
      "path": "docs/content/docs/authentication/auth.mdx",
      "proseWords": 92,
      "minWords": 350
    }
  ],
  "missingSections": [
    {
      "path": "docs/content/docs/authentication/auth.mdx",
      "headings": [
        "## What It Is",
        "## When To Use It",
        "## Install",
        "## Core Concepts",
        "## Real-World Example",
        "## Related Packages"
      ]
    }
  ],
  "placeholderHits": [
    {
      "path": "docs/content/docs/authentication/auth.mdx",
      "phrase": "Reference and usage guidance"
    }
  ]
}
```
- **Negative variant(s)**:
```json
{
  "pages": [
    {
      "path": "docs/content/docs/authentication/auth.mdx",
      "proseWords": 468,
      "headings": [
        "## What It Is",
        "## When To Use It",
        "## Install",
        "## Quick Start",
        "## Core Concepts",
        "## Real-World Example",
        "## Related Packages",
        "## Troubleshooting"
      ],
      "placeholderHits": [],
      "imports": ["@superfunctions/auth"]
    }
  ]
}
```
Expected success:
```json
{
  "ok": true,
  "error": null
}
```

# TV-QA-002

- **Description**: Local verification suite succeeds for a complete docs implementation.
- **Input**:
```json
{
  "commands": [
    "npm -w docs run build",
    "npm -w docs run check:catalog",
    "npm -w docs run check:content",
    "npm -w docs run check:snippets",
    "npm -w docs run check:links"
  ]
}
```
- **Expected output**:
```json
{
  "ok": true,
  "failingCommands": []
}
```
- **Negative variant(s)**:
```json
{
  "commands": [
    "npm -w docs run build",
    "npm -w docs run check:content"
  ],
  "results": {
    "npm -w docs run build": 0,
    "npm -w docs run check:content": 1
  }
}
```
Expected error:
```json
{
  "ok": false,
  "error": { "code": "DOCS_CONTENT_INVALID", "message": "Docs verification suite failed." },
  "failingCommands": ["npm -w docs run check:content"]
}
```
