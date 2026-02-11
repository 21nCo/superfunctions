# compfn – Compliance Function: Approach & Ecosystem Fit

> Self-hosted compliance automation for SOC 2, ISO 27001, HIPAA, GDPR, and more.  
> Think Vanta / Drata / Sprinto – but you own the data and the stack.

---

## 1. What compfn Is For

**compfn** addresses **compliance and regulations**: framework-based control mapping, evidence collection, continuous monitoring, and audit-ready reporting. It does **not** replace **secfn** (security controls: RBAC, secrets, scanning, rate limiting). It **consumes** secfn (and other superfunctions) as **evidence sources** and turns them into compliance artifacts.

| Concern | secfn | compfn |
|--------|--------|--------|
| Access control (RBAC) | Implements | Uses as evidence (e.g. “access reviews”) |
| Secrets management | Implements | Uses as evidence (e.g. “no hardcoded secrets”) |
| Security events / audit log | Implements | Consumes for control evidence |
| “Are we SOC 2 ready?” | — | Maps controls, collects evidence, reports |
| “Evidence for auditor” | — | Stores and exports evidence, generates reports |

---

## 2. Approach: Control-Centric, Framework-Agnostic

### 2.1 One Control Model, Many Frameworks

- **Controls** are the primary entity (e.g. “Access reviews performed quarterly”, “Secrets in vault”, “Backups tested”).
- **Frameworks** (SOC 2, ISO 27001, HIPAA, GDPR, etc.) reference these controls via a **mapping layer**.
- Implement each control once; compfn handles “which frameworks does this satisfy?” and “what evidence do we have?”.

Benefits:

- No duplicate evidence per framework.
- Add new frameworks by mapping existing controls.
- Aligns with how auditors work (controls + evidence).

### 2.2 Evidence Sources: Superfunctions First

Evidence is collected from:

1. **Other superfunctions (primary)**  
   - **authfn**: user lifecycle, MFA, session policies → access, identity controls.  
   - **secfn**: RBAC, secrets vault, scanning results, security events → access, secrets, vulnerability controls.  
   - **logfn**: centralized logs, retention → logging and monitoring controls.  
   - **watchfn**: uptime, alerts → availability and incident controls.  
   - **hostfn**: deployment, backups, env handling → infrastructure and change controls.  
   - **flowfn**: job/audit logs → change and process controls.  
   - **filefn**: storage, access, retention → data handling controls.  
   - **plugfn**: integration audit trail → third-party access controls.

2. **compfn-native**  
   - Policy/document uploads (PDFs, docs).  
   - Manual attestations (e.g. “Quarterly access review completed”).  
   - Scheduled questionnaires (e.g. “Confirm backup test date”).  
   - Custom checks (scripts or API calls that return pass/fail + snippet).

3. **External (optional)**  
   - Webhooks or pull from external systems (e.g. HR, IDP) when not yet covered by authfn/plugfn.

### 2.3 Continuous Monitoring, Not Point-in-Time Only

- **Checks** run on a schedule (or on event) and produce **evidence records** (pass/fail, timestamp, link to source).
- Examples: “RBAC enabled in secfn”, “Backup job ran in flowfn”, “No critical secrets in code (secfn scan)”.
- compfn stores results and attaches them to the right control → framework so readiness and gaps are always up to date.

### 2.4 Audit Trail and Reporting

- All evidence ingestion and manual attestations are **immutable and logged** (who, when, what).
- **Export**: auditor pack (evidence + mapping + dates) in a structured format (e.g. JSON + PDF/HTML summary).
- **Readiness views**: per-framework and per-control status (compliant / not compliant / not applicable) with last evidence date.

---

## 3. How compfn Fits the Superfunctions Ecosystem

### 3.1 compfn as Consumer (Plugin / Integration Points)

- **authfn**: read users, roles, MFA status, session config; optionally trigger “access review” workflows.  
- **secfn**: read RBAC config, secret-scan results, security events; use for control evidence.  
- **logfn**: query logs (retention, coverage) for logging controls.  
- **watchfn**: read monitors and incidents for availability/incident controls.  
- **hostfn**: read deployment history, backup/rollback capability for infra controls.  
- **flowfn**: read job definitions and execution logs for change/process controls.  
- **filefn**: metadata and retention for data-handling controls.  
- **plugfn**: connection and action logs for third-party access controls.

compfn does **not** implement those capabilities; it **calls** them (via SDK or API) and normalizes results into **control evidence**.

### 3.2 compfn as Provider (What Others Use From compfn)

- **productFn / superFn**: “Compliance status” widget, “Evidence due” tasks, links to compfn dashboard.  
- **userfn**: “Compliance requests” or “Attestation due” in user feedback flows.  
- **flowfn**: workflows that create attestations or run compfn checks on a schedule.

### 3.3 Same Patterns as Other Superfunctions

- **SDK**: programmatic API (controls, evidence, checks, reports).  
- **Server**: optional HTTP API for UI, webhooks, and cross-service evidence collection.  
- **Storage**: same adapter pattern as secfn/datafn (e.g. `@superfunctions/db`); evidence and config in your DB.  
- **Admin**: optional dashboard (readiness, evidence, mappings, exports).  
- **CLI**: init, run checks, export report, maybe “compfn attest …”.

---

## 4. Self-Deployability and Why It Matters

### 4.1 Data and Control Stay On Your Side

- Evidence (logs, scan results, attestations, uploaded docs) stays in **your** database and object storage.
- No “send everything to Vanta/Drata/Sprinto”; you deploy compfn (and its dependencies) with **hostfn** on your VPS or cloud.
- Critical for regulated industries and teams that cannot ship full audit trails to third-party SaaS.

### 4.2 Single Stack to Operate

- One deployment story: **hostfn** deploys the app that uses authfn, secfn, logfn, **compfn**, etc.
- Same env, same DB, same backup/restore story; compliance evidence is just another part of that stack.
- Reduces “we use vendor X for compliance” and the associated SSO, DPA, and vendor-audit overhead.

### 4.3 No Vendor Lock-In for Compliance Logic

- Control definitions and framework mappings are **data** (or code you own), not a black box.
- You can extend frameworks, add custom controls, and change evidence sources without depending on a SaaS roadmap.

### 4.4 Optional “Compliance as a Service” Later

- If you build a hosted offering, you can offer “compfn as a service” where **you** run compfn and the customer’s evidence is still isolated (multi-tenant DB + storage). The same compfn codebase supports both self-hosted and hosted.

---

## 5. Suggested Implementation Shape (High Level)

- **Control registry**: id, name, description, category; optional tags for framework-agnostic grouping.  
- **Framework definitions**: e.g. “SOC 2 Type II”, “ISO 27001:2022”; each has a list of **control IDs** (and maybe requirement IDs).  
- **Evidence model**: type (automated_from_secfn, manual_attestation, file_upload, questionnaire, custom_check), source_id, control_id, timestamp, payload (or reference to file/store), optional framework_requirement_id.  
- **Checks**: definition (name, control_id, schedule or trigger, how to run – e.g. “call secfn.getRbacStatus()”, “run script”), store result as evidence.  
- **Integrations**: small adapters per superfunction (authfn, secfn, logfn, watchfn, hostfn, flowfn, filefn, plugfn) that translate their output into evidence records.  
- **API**: CRUD for controls, frameworks, evidence; “run check”; “export report for framework X”; “readiness for framework X”.  
- **Dashboard**: list controls, attach evidence, view readiness, run/see check results, export.

This can be implemented in **phases**: control + framework + manual evidence first; then automated evidence from 1–2 superfunctions (e.g. secfn, authfn); then more sources and richer reporting.

---

## 6. How This Helps the Superfunctions Ecosystem

- **Differentiation**: “Self-deployable compliance” that uses the same building blocks (authfn, secfn, logfn, hostfn, etc.) is a clear story vs. “we use Drata” (data leaves your perimeter).  
- **Coherence**: Compliance becomes a **first-class outcome** of the stack, not an afterthought or a separate vendor.  
- **Reuse**: Every superfunction that produces structured data (events, config, scan results) becomes a potential evidence source; compfn is the **compliance layer** on top.  
- **Roadmap**: secfn can stay focused on “security controls”; compfn owns “compliance and audit” and consumes secfn.  
- **Self-deployability**: One narrative – “from auth to hosting to compliance, you deploy it yourself” – with compfn as the piece that ties evidence and frameworks together.

---

## 7. Next Steps (Suggested)

1. **Spec**  
   - Add `compfn/SPEC.md` (control model, evidence types, API, storage, integrations with authfn/secfn/logfn, etc.).  
   - Align with secfn SPEC (secfn = controls; compfn = compliance reporting on top).

2. **Pop**  
   - Keep compfn in `pop.md` with spec → ts → publish and py → publish; prioritize spec and one runtime (e.g. TS) first.

3. **Evidence adapters**  
   - Start with secfn + authfn (RBAC, secrets, MFA, users) as the first automated evidence sources; then logfn, hostfn, flowfn.

4. **Frameworks**  
   - Ship 1–2 framework definitions (e.g. SOC 2 Type II, ISO 27001) as data/bundles so early adopters get value without building mappings from scratch.

5. **Hostfn**  
   - Document “deploying an app with compfn” (same as other fns: include compfn in the app, run migrations, configure checks and evidence sources).

This gives you a clear **compfn** approach that covers “all compliance needs” (Vanta/Drata/Sprinto-style) while fitting the superfunctions ecosystem and maximizing self-deployability and data ownership.
