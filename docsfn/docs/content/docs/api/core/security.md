---
title: core — Security
description: HTML trust, auth, and redaction helpers in @docsfn/core.
---

# Security (`@docsfn/core`)

## HTML sanitization (`sanitize.ts`)

| Export | Role |
| --- | --- |
| **`BLOCKED_HTML_TAGS`** | Tags rejected in Markdown sources (`script`, `iframe`, `object`, `embed`, `link`, `meta`). |
| **`BLOCKED_HTML_PATTERNS`** | Event-handler attributes and unsafe URL schemes. |
| **`findUnsafeHtml(source)`** | Returns match metadata. |
| **`assertSafeSource(input)`** | Throws **`DOCS_HTML_UNSAFE`** when matches exist (unless raw HTML allowed). |

## Trust assertions

| Function | Role |
| --- | --- |
| **`assertSourceEntriesTrusted`** | Validates Markdown entries before manifest compile. |
| **`assertCompiledContentTrusted`** | Validates transformed Markdown prior to UI compile. |
| **`collectUnsafeHtmlDiagnostics`** | Non-throwing diagnostic collector. |

**`resolveUnsafeHtmlAllowlist`** merges env **`DOCSFN_HTML_UNSAFE_ALLOWLIST`** (comma-separated globs).

## Auth

| Export | Role |
| --- | --- |
| **`CANONICAL_DOCS_AUTH_MODES`** | `["public","private","mixed"]`. |
| **`resolveDocsAuthMode`** | Maps config → mode (disabled auth → `public`). |
| **`assertDocsRouteAccess`** | Async gate: throws **`DOCS_AUTH_REQUIRED`** / **`DOCS_AUTH_FORBIDDEN`**. |

## Redaction

**`redactSensitiveText`**, **`redactSensitivePayload`** — strip common secret patterns from strings and nested objects (used by search + analytics).
