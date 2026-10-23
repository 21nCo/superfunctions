# CompFn Intent Audit

## Purpose

Exhaustive audit mapping every intent item from compfn.intent.md and COMPFN_APPROACH.md to SPEC.md sections, REQUIREMENTS.md IDs, and TEST_VECTORS.md vectors. Ensures full scope coverage.

---

## Intent inventory (from compfn.intent.md + COMPFN_APPROACH.md)

| # | Intent summary |
|---|----------------|
| I01 | Control-centric, framework-agnostic: controls primary; frameworks reference controls via mapping; one control many frameworks; evidence attached to controls |
| I02 | Evidence from superfunctions: consume authfn, secfn, logfn, watchfn, hostfn, flowfn, filefn, plugfn; do not implement security; normalize to control evidence |
| I03 | CompFn-native evidence: policy/doc uploads, manual attestations, questionnaires, custom checks; all immutable and auditable (who, when, what) |
| I04 | Continuous monitoring: checks on schedule or event; produce evidence records; readiness and gaps up to date |
| I05 | Audit trail and reporting: immutable evidence log; export auditor pack (evidence + mapping + dates) JSON + optional PDF/HTML; readiness per framework and per control (compliant/not compliant/N/A) with last evidence date |
| I06 | Self-deployable: evidence in deployer DB/storage; no vendor SaaS; hostfn deployment story |
| I07 | SDK and optional server: programmatic API (controls, evidence, checks, reports); optional HTTP API; storage via @superfunctions/db adapter |
| I08 | Integrations as adapters: small adapters per superfunction; pluggable; compfn works with subset |
| I09 | Frameworks as data: framework definitions as data/bundles; at least one framework bundle shipped |
| I10 | No replacement for secfn: compfn consumes secfn; does not re-implement security |
| I11 | Provider to productFn/userfn/flowfn: compliance status, evidence-due tasks, attestation workflows consumable |
| I12 | Observability: MUST log (evidence ingestion, check runs, export); MUST NOT log (raw evidence payloads with PII/secrets in production) |
| I13 | Versioning: control and framework schema versioning and compatibility stated |
| I14 | Limits: max evidence payload size, retention defaults, export size caps defined |
| I15 | Control registry: id, name, description, category; optional tags |
| I16 | Framework definitions: e.g. SOC 2 Type II; list of control IDs and optionally requirement IDs |
| I17 | Evidence model: type (automated_*, manual_attestation, file_upload, questionnaire, custom_check), source_id, control_id, timestamp, payload or file ref, optional framework_requirement_id |
| I18 | Checks: name, control_id, schedule or trigger, how to run; store result as evidence |
| I19 | API: CRUD controls, frameworks, evidence; run check; export report for framework X; readiness for framework X |
| I20 | Dashboard (optional): list controls, attach evidence, view readiness, run/see checks, export |
| I21 | CLI: init, run checks, export report, compfn attest |
| I22 | External evidence (optional): webhooks or pull from external systems |
| I23 | Multi-tenant: optional "compliance as a service" with tenant isolation |
| I24 | Error codes and failure behavior for all operations; canonical envelope |
| I25 | Determinism: readiness same inputs → same status; list ordering documented; timestamps actual |
| I26 | Authz boundaries: who can add evidence, run checks, export (deployment-defined) |

---

## Intent → Spec coverage

| Intent | SPEC.md section | Requirement IDs | Test vectors |
|--------|-----------------|-----------------|--------------|
| I01 | Overview, Glossary (Control, Framework), Goals, Public API (Control, Framework, mapping) | CTRL-001, FW-001, FW-002 | TV-CTRL-*, TV-FW-*, TV-EXPORT-002 |
| I02 | Overview, Glossary (Adapter), Public API (EvidenceAdapter), Semantics (checks run adapter) | ADAPT-001, ADAPT-002, ADAPT-003, CHECK-001, CHECK-002 | TV-ADAPT-*, TV-CHECK-* |
| I03 | Glossary (Evidence), Public API (Evidence, EvidenceType), Semantics (evidence create) | EVID-001, EVID-002, EVID-003 | TV-EVID-*, TV-CLI-002 (attest) |
| I04 | Glossary (Check), Public API (checks.run), Semantics (checks) | CHECK-001, CHECK-002 | TV-CHECK-RUN-*, TV-CHECK-EVIDENCE-001 |
| I05 | Glossary (Readiness, Auditor pack), Public API (readiness, export), Semantics | READY-001, EXPORT-001 | TV-READY-*, TV-EXPORT-* |
| I06 | Overview (Non-goals, Hard constraints), Security, Limits | API-001, LIMIT-001 | All (storage adapter; no SaaS required) |
| I07 | Public API (CompFnAPI, CompFnConfig), Data formats, Optional HTTP API | API-001, HTTP-001 | TV-API-CONFIG-001, TV-HTTP-001 |
| I08 | Glossary (Adapter), Public API (adapters in config) | ADAPT-001, ADAPT-002, ADAPT-003 | TV-ADAPT-INTERFACE-001 |
| I09 | Goals, Public API (Framework), Phase 08 | BUNDLE-001 | TV-BUNDLE-001 |
| I10 | Overview, Non-goals, Hard constraints | (Spec states compfn does not implement security) | N/A (design) |
| I11 | Public API (readiness, evidence.list), Phase 12 | PROVIDER-001 | TV-PROVIDER-001 |
| I12 | Observability | OBS-001 | TV-OBS-001 |
| I13 | Compatibility / versioning | COMPAT-001 | Documentation audit |
| I14 | Limits / caps | LIMIT-001 | TV-LIMIT-* |
| I15 | Public API (Control, CreateControlInput) | CTRL-001 | TV-CTRL-* |
| I16 | Public API (Framework, FrameworkRequirement) | FW-001, FW-002 | TV-FW-* |
| I17 | Public API (Evidence, EvidenceType, CreateEvidenceInput) | EVID-001, EVID-002 | TV-EVID-* |
| I18 | Public API (CheckDefinition, checks.run) | CHECK-001, CHECK-002 | TV-CHECK-* |
| I19 | Public API (CompFnAPI full surface) | CTRL-001, FW-001, EVID-*, CHECK-*, READY-001, EXPORT-001 | All TV-* |
| I20 | Undefined / optional (dashboard) | — | Explicitly optional in SPEC |
| I21 | Optional CLI | CLI-001 | TV-CLI-* |
| I22 | EvidenceType external_webhook (optional) | EVID-002 (type enum) | Optional; in types |
| I23 | Security (optional tenantId); Undefined | — | Optional in SPEC |
| I24 | Data formats (Envelope), Public API (CompfnError, CompfnErrorCode) | API-002 | TV-ENVELOPE-*, TV-*-002 negative vectors |
| I25 | Invariants (Determinism), Semantics (readiness) | READY-001 | TV-READY-* |
| I26 | Security (Authz) | SPEC Security section | Deployment-defined; documented |

---

## Missing intent items

**No missing intent items.** All 26 intent items are covered by at least one SPEC section and (where applicable) requirement IDs and test vectors. Optional items (I20 dashboard, I22 external_webhook, I23 multi-tenant) are either in Public API as optional or in Undefined/Explicitly user-deferred. I10 (no replacement for secfn) is enforced by SPEC Hard constraints and Non-goals. I26 (authz) is in Security as deployment-defined.

---

## Verification

- Intent inventory is exhaustive from compfn.intent.md and COMPFN_APPROACH.md.
- Every MUST-level requirement in REQUIREMENTS.md has at least one positive and (where applicable) one negative test vector in TEST_VECTORS.md.
- SPEC.md uses normative language (MUST/SHOULD/MAY), defines envelope and error codes, and includes Metadata, Overview, Glossary, Goals, Non-goals, Public API, Data formats, Semantics, Invariants, Security, Limits, Observability, Compatibility, Undefined.
