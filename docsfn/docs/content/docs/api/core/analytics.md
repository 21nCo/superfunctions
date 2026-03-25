---
title: core — Analytics
description: Canonical analytics event names and emit helpers in @docsfn/core.
---

# Analytics (`@docsfn/core`)

## Event names

**`CANONICAL_DOCS_ANALYTICS_EVENT_NAMES`:**

- `docs.pageview`
- `docs.search`
- `docs.search_result_click`
- `docs.external_click`

**`DocsAnalyticsEventName`** — union of the above.

## `DocsAnalyticsEvent`

Fields include **`name`**, ISO **`timestamp`**, **`route`**, optional **`version`**, **`sidebarId`**, **`searchScope`**, **`resultCount`**, **`targetUrl`**.

## Emit pipeline

| Function | Role |
| --- | --- |
| **`maybeEmitAnalyticsEvent`** | Respects **`respectDnt`** + optional explicit DNT value; calls your **`emit`** callback. |
| **`createDocsAnalyticsEmitter`** | Factory for a reusable emitter with defaults. |

URL-like fields are sanitized to drop sensitive query keys before emission (see implementation in `analytics.ts`).
