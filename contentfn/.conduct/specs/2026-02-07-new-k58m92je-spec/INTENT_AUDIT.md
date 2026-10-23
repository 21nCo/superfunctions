# ContentFn Intent Audit

## Purpose

Exhaustive audit mapping every intent item derived from authoritative inputs to SPEC.md sections, REQUIREMENTS.md requirement IDs, and TEST_VECTORS.md verification vectors. This file MUST end with an explicit statement of coverage completeness.

## Authoritative inputs reviewed

- https://www.fetch.at/spec.txt (spec-writing rules)
- `/Users/ar/dev/superfunctions/pop.md` (ecosystem roadmap; includes `contentfn`)
- `/Users/ar/dev/superfunctions/docsfn/.conduct/spec.md` and `implementation.md` (ecosystem integration expectations: future `cmsfn` as content provider; headless providers)
- User prompt (chat): “managing content like self hosted sanity.io”

## Intent inventory

| # | Intent item (exhaustive for provided inputs) |
|---|---------------------------------------------|
| I01 | Provide a self-hosted, Sanity-like headless content engine in the Superfunctions ecosystem |
| I02 | Must be schema-driven (document types + fields + validation) |
| I03 | Must store and serve documents with stable IDs and system fields |
| I04 | Must support drafts vs published perspectives |
| I05 | Must support publishing/unpublishing workflows |
| I06 | Must support patch-based mutations suitable for editorial updates |
| I07 | Must support optimistic concurrency to prevent overwrites |
| I08 | Must maintain revision history and support restore/rollback |
| I09 | Must support deterministic querying with filtering, ordering, pagination, projection |
| I10 | Must support references between documents and bounded expansion |
| I11 | Must support assets (files/images) and asset references from documents |
| I12 | Must provide change events (webhooks + realtime feed) for preview/tooling |
| I13 | Must integrate with Superfunctions primitives (notably `@superfunctions/db`) and be self-hosted (no required vendor SaaS) |
| I14 | Must have explicit security boundaries (authz hook; no cross-dataset leakage) |
| I15 | Must enforce limits to prevent abuse (payload/query complexity) |
| I16 | Must be observable without leaking raw document bodies/asset bytes |
| I17 | Must expose a status/capabilities endpoint |
| I18 | Must support dataset export/import for backup/restore/promotion |
| I19 | Should support search/match behavior deterministically (enabled vs disabled) |
| I20 | Should provide a CLI for automation (schema/dataset/doc operations) |

## Intent → Spec coverage

| Intent | SPEC.md section(s) | Requirement IDs | Test vectors |
|--------|---------------------|-----------------|--------------|
| I01 | Overview; Goals | API-001 | TV-API-CONFIG-001 |
| I02 | Public API (Schema types); Semantics → Schema | SCHEMA-001, SCHEMA-002 | TV-SCHEMA-UPSERT-001/002, TV-SCHEMA-GET-001, TV-SCHEMA-VERSION-001/002 |
| I03 | Public API (Document types); Data formats → Document identity | DOC-001 | TV-DOC-CREATE-001/002, TV-DOC-GET-001/002, TV-DOC-DELETE-001 |
| I04 | Semantics → Document perspectives; Data formats → Document identity | DOC-002 | TV-DOC-DRAFT-ID-001, TV-DOC-PERSPECTIVE-001/002 |
| I05 | Semantics → Publish/Unpublish | DOC-003 | TV-DOC-PUBLISH-001/002, TV-DOC-UNPUBLISH-001 |
| I06 | Public API → Patch API; Semantics → Patch | PATCH-001 | TV-PATCH-SET-001, TV-PATCH-UNSET-001, TV-PATCH-INVALID-001, TV-PATCH-NONNUM-001 |
| I07 | Data formats → Revisions; Invariants → Consistency | REV-001 | TV-REV-CONFLICT-001 |
| I08 | Semantics → Revision history; Invariants → Immutability | HIST-001 | TV-HIST-LIST-001, TV-RESTORE-001/002 |
| I09 | Public API → CFQL; Semantics → Query (CFQL); Invariants → Ordering/Determinism | QRY-001, QRY-002 | TV-QRY-001, TV-QRY-PROJECTION-001, TV-QRY-INVALID-001, TV-QRY-ORDER-DEFAULT-001, TV-QRY-ORDER-TIEBREAK-001, TV-QRY-CURSOR-001 |
| I10 | Data formats → Reference encoding; Semantics → Query expansion | REF-001 | TV-REF-ENCODE-001, TV-REF-EXPAND-001/002, TV-REF-CYCLE-001 |
| I11 | Semantics → Assets; Data formats → Asset references | ASSET-001 | TV-ASSET-UPLOAD-001/002, TV-ASSET-GET-001/002 |
| I12 | Data formats → Webhook delivery; Semantics → Webhooks + Realtime feed | WH-001, RT-001 | TV-WH-REGISTER-001/002, TV-WH-DELIVERY-001, TV-RT-SUBSCRIBE-001/002, TV-RT-EVENTS-001 |
| I13 | Overview (self-hosted); Public API (db adapter); Security | API-001, DS-001 | TV-DS-ISOLATION-001 |
| I14 | Security; Semantics → Datasets isolation | AUTH-001, DS-001 | TV-AUTH-ALLOW-001, TV-AUTH-DENY-001, TV-DS-ISOLATION-001 |
| I15 | Limits/caps; Semantics (bounded expansion) | LIMIT-001 | TV-LIMIT-PAYLOAD-001, TV-LIMIT-PATCHOPS-001, TV-REF-EXPAND-002 |
| I16 | Observability; Security (no secrets in logs) | OBS-001 | TV-OBS-LOGGING-001/002 |
| I17 | HTTP API → /contentfn/status | STATUS-001 | TV-STATUS-001/002 |
| I18 | Semantics → Import/export | IMP-001 | TV-IMP-EXPORT-001, TV-IMP-IMPORT-001/002 |
| I19 | CFQL operator match (Semantics + Requirements) | SEARCH-001 | TV-QRY-MATCH-001/002 |
| I20 | REQUIREMENTS P1 CLI; PLAN phases | CLI-001 | TV-CLI-001/002/003 |

## Missing intent items

**No missing intent items.** All intent items I01–I20 are covered by SPEC.md sections and implemented by at least one requirement ID. For each MUST-level requirement, test vectors include positive and negative coverage.

