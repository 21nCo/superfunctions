# CompFn Intent

## One-sentence goal

CompFn is a self-hosted compliance function in the superfunctions ecosystem that maps controls to frameworks (SOC 2, ISO 27001, HIPAA, GDPR, etc.), collects evidence from superfunctions and manual inputs, runs continuous checks, and produces audit-ready reports—so teams can achieve and maintain compliance without sending data to third-party SaaS (Vanta, Drata, Sprinto style).

## Scope

1. **Control-centric, framework-agnostic**: Controls are the primary entity (e.g. "Access reviews performed quarterly", "Secrets in vault"). Frameworks reference controls via a mapping layer. One control satisfies many frameworks; evidence is attached to controls, not duplicated per framework.

2. **Evidence from superfunctions**: CompFn consumes authfn, secfn, logfn, watchfn, hostfn, flowfn, filefn, plugfn as evidence sources. It does not implement security; it reads their outputs and normalizes into control evidence (e.g. secfn RBAC status → access control evidence).

3. **CompFn-native evidence**: Policy/document uploads, manual attestations, scheduled questionnaires, and custom checks (scripts or API calls returning pass/fail) are first-class evidence types. All evidence is immutable and auditable (who, when, what).

4. **Continuous monitoring**: Checks run on a schedule or event and produce evidence records. Readiness and gaps are always up to date, not only at audit time.

5. **Audit trail and reporting**: Immutable evidence log; export auditor pack (evidence + mapping + dates) in structured format (JSON + PDF/HTML summary). Readiness views per framework and per control (compliant / not compliant / not applicable) with last evidence date.

6. **Self-deployable**: Evidence stays in the deployer's database and storage. No vendor SaaS holding audit trails. Same deployment story as other superfunctions (hostfn deploys app with compfn; one stack, one backup).

7. **SDK and optional server**: Programmatic API (controls, evidence, checks, reports). Optional HTTP API for UI, webhooks, cross-service evidence collection. Storage via same adapter pattern as secfn/datafn (@superfunctions/db).

8. **Integrations as adapters**: Small adapters per superfunction (authfn, secfn, logfn, etc.) that translate their output into evidence records. Adapters are pluggable; compfn works with a subset of sources.

9. **Frameworks as data**: Framework definitions (e.g. SOC 2 Type II, ISO 27001) are data/bundles. At least one framework bundle shipped so early adopters get value without building mappings from scratch.

10. **No replacement for secfn**: Secfn implements security controls (RBAC, secrets, scanning). CompFn implements compliance and audit (mapping, evidence, reporting). CompFn consumes secfn; it does not re-implement security.

11. **Provider to productFn/userfn/flowfn**: Compliance status, evidence-due tasks, and attestation workflows can be consumed by productFn, userfn, flowfn (e.g. "attestation due" in user feedback, scheduled compfn checks in flowfn).

12. **Observability**: What MUST be logged (evidence ingestion, check runs, export) and what MUST NOT be logged (raw evidence payloads that may contain PII/secrets in production) MUST be specified.

13. **Versioning**: Control and framework schema versioning and compatibility strategy MUST be stated so that evidence and mappings remain valid across upgrades.

14. **Limits**: Max evidence payload size, retention defaults, and export size caps MUST be defined where relevant.
