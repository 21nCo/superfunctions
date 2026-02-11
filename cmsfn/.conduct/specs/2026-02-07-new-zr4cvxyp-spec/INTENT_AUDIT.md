# CmsFn Intent Audit

## Purpose

Exhaustive audit mapping every intent item derived from authoritative inputs to SPEC.md sections, REQUIREMENTS.md requirement IDs, and TEST_VECTORS.md verification vectors.

## Authoritative inputs reviewed

- https://www.fetch.at/spec.txt (spec-writing rules)
- `/Users/ar/dev/superfunctions/docsfn/.conduct/spec.md` (expects future `cmsfn` as CMS provider; `docsfn` is headless, not WYSIWYG)
- `/Users/ar/dev/superfunctions/contentfn/.conduct/specs/2026-02-07-new-k58m92je-spec/SPEC.md` (ContentFn API/semantics; CmsFn consumes it)
- User prompt (chat): “managing content like self hosted sanity.io”

## Intent inventory

| # | Intent item (exhaustive for provided inputs) |
|---|---------------------------------------------|
| I01 | Provide a self-hosted, Sanity-like CMS authoring experience (Studio UI) in the Superfunctions ecosystem |
| I02 | Studio must be schema-driven using ContentFn schema (render editors from types/fields) |
| I03 | Studio must support drafts and publish/unpublish workflows via ContentFn |
| I04 | Studio must provide deterministic content browsing (lists, ordering, pagination) |
| I05 | Studio must manage assets (media library UX) via ContentFn assets |
| I06 | Studio must manage references (picker/search) via ContentFn docs query/expand |
| I07 | Studio must support preview with live updates (realtime + tokens) |
| I08 | Studio must enforce permissions and support role management (server-side enforcement) |
| I09 | Studio must provide workflows (review/approval gates) |
| I10 | Studio must support releases (batch publish + scheduling) |
| I11 | Studio must provide operational surfaces (audit logs, webhook status, import/export triggers) |
| I12 | Studio must be self-hosted and not require vendor SaaS |
| I13 | CmsFn must check ContentFn availability/capabilities and fail explicitly when missing |
| I14 | Logs/observability must not leak raw content/bytes/secrets |
| I15 | Limits must be enforced deterministically (uploads/richtext/release size) |

## Intent → Spec coverage

| Intent | SPEC.md section(s) | Requirement IDs | Test vectors |
|--------|---------------------|-----------------|--------------|
| I01 | Overview; Goals | STUDIO-001 | TV-STUDIO-BOOT-001 |
| I02 | Semantics → Document editing; Public API → Studio config | SCHEMA-001, SCHEMA-002 | TV-EDITOR-RENDER-001/002, TV-EDITOR-VALIDATE-001/002 |
| I03 | Semantics → Document editing; Draft/published | DOC-003 | TV-WORKFLOW-PUBLISH-001, TV-WORKFLOW-UNPUBLISH-001 |
| I04 | Semantics → Studio UX invariants | DOC-001, STUDIO-002 | TV-LIST-QUERY-001, TV-LIST-PAGINATION-001, TV-DATASET-SCOPE-001 |
| I05 | Semantics → Media library | MEDIA-001 | TV-MEDIA-UPLOAD-001, TV-MEDIA-BROWSE-001, TV-MEDIA-INSERT-001 |
| I06 | Semantics → References | REF-001 | TV-REF-PICKER-001/002 |
| I07 | Semantics → Preview | PREVIEW-001 | TV-PREVIEW-TOKEN-001, TV-PREVIEW-LIVE-001, TV-PREVIEW-DISABLED-001 |
| I08 | Data formats → Roles; Security | ROLE-001 | TV-ROLE-UPSERT-001, TV-ROLE-DENY-001 |
| I09 | Data formats → Workflow states; Semantics → gating | WF-001 | TV-WF-STATE-001, TV-WF-PUBLISH-GATE-001 |
| I10 | Semantics → releases | REL-001 | TV-REL-CREATE-001, TV-REL-PUBLISH-001/002 |
| I11 | Semantics → Ops + Audit | OPS-001, AUDIT-001 | TV-OPS-EXPORT-001, TV-AUDIT-EVENTS-001, TV-AUDIT-DENY-001 |
| I12 | Overview; Non-goals | (Design constraint) | N/A |
| I13 | Compatibility/versioning strategy; Status | STATUS-001 | TV-STATUS-CONTENTFN-DOWN-001 |
| I14 | Observability | OBS-001 | TV-OBS-001/002 |
| I15 | Limits | LIMIT-001 | TV-LIMIT-UPLOAD-001, TV-LIMIT-RICHTEXT-001, TV-LIMIT-RELEASE-001 |

## Missing intent items

**No missing intent items.** I01–I15 are each covered by SPEC.md sections and mapped to requirement IDs and test vectors.

