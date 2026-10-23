# @superfunctions/compfn

Self-hosted compliance function for managing controls, frameworks, evidence, checks, and audit-ready exports.

## Overview

CompFn is a compliance automation tool that:
- Maps **controls** to **frameworks** (SOC 2, ISO 27001, HIPAA, GDPR, etc.)
- Collects **evidence** from superfunctions and manual sources
- Runs **continuous checks** to verify compliance
- Produces **audit-ready reports**
- Keeps all evidence on your own infrastructure (no mandatory SaaS)

## Installation

```bash
npm install @superfunctions/compfn
```

## Quick Start

```typescript
import { compFn } from "@superfunctions/compfn";
import { memoryAdapter } from "@superfunctions/db/adapters";

const db = memoryAdapter();
await db.initialize();

const api = compFn({
  database: db,
  namespace: "compfn",
});

const control = await api.controls.create({
  name: "Access reviews",
  description: "Quarterly access reviews",
  category: "access",
  tags: ["soc2"],
});

console.log(control);
```

## Core API

The `compFn()` function returns a `CompFnAPI` instance with the following namespaces:

- `controls` - Create, read, update, delete controls
- `frameworks` - Manage compliance frameworks and requirement mappings
- `evidence` - Create and query evidence (immutable)
- `checks` - Define and run compliance checks
- `readiness` - Get compliance status for controls and frameworks
- `export` - Generate auditor packs

All methods return a `CompfnEnvelope<T>`:
- Success: `{ ok: true, result: T }`
- Failure: `{ ok: false, error: { code, message, details } }`

### Error Codes

- `CONTROL_NOT_FOUND` - Control does not exist
- `FRAMEWORK_NOT_FOUND` - Framework does not exist
- `EVIDENCE_NOT_FOUND` - Evidence does not exist
- `CHECK_NOT_FOUND` - Check does not exist
- `VALIDATION_FAILED` - Input validation failed
- `ADAPTER_NOT_FOUND` - Evidence adapter not configured
- `ADAPTER_ERROR` - Evidence adapter threw an error
- `STORAGE_ERROR` - Database operation failed
- `EXPORT_FAILED` - Export size exceeded limit
- `PAYLOAD_TOO_LARGE` - Evidence payload exceeds size limit
- `RATE_LIMITED` - Rate limit exceeded

## HTTP API

CompFn provides an optional HTTP server that exposes all core functionality via REST endpoints.

### Setup

```typescript
import { compFn, createCompFnRouter } from "@superfunctions/compfn";
import { serve } from "@hono/node-server";

const api = compFn({ database: db, namespace: "compfn" });
const app = createCompFnRouter(api);

serve({ fetch: app.fetch, port: 3000 });
console.log("CompFn HTTP API running on http://localhost:3000");
```

### Response Envelope

All HTTP endpoints return a JSON envelope:

**Success (2xx):**
```json
{
  "ok": true,
  "result": { ... }
}
```

**Failure (4xx/5xx):**
```json
{
  "ok": false,
  "error": {
    "code": "CONTROL_NOT_FOUND",
    "message": "Control not found",
    "details": { "id": "ctrl_123" }
  }
}
```

### Status Codes

- `200` - Successful GET, PATCH, DELETE, or POST (non-create)
- `201` - Successful POST (create)
- `400` - Validation failed (`VALIDATION_FAILED`)
- `404` - Resource not found (e.g., `CONTROL_NOT_FOUND`)
- `413` - Payload too large (`PAYLOAD_TOO_LARGE`)
- `429` - Rate limited (`RATE_LIMITED`)
- `500` - Server error (e.g., `STORAGE_ERROR`, `ADAPTER_ERROR`)

### Endpoints

#### Controls

**POST /controls**
Create a new control.

Request body:
```json
{
  "name": "Access reviews",
  "description": "Quarterly access reviews",
  "category": "access",
  "tags": ["soc2"]
}
```

Response: `201` with `{ ok: true, result: Control }`

---

**GET /controls**
List all controls. Supports optional query parameters:
- `category` - Filter by category
- `tags` - Comma-separated list of tags

Response: `200` with `{ ok: true, result: Control[] }`

---

**GET /controls/:id**
Get a control by ID.

Response: `200` with `{ ok: true, result: Control }` or `404` with `CONTROL_NOT_FOUND`

---

**PATCH /controls/:id**
Update a control.

Request body (all fields optional):
```json
{
  "name": "Updated name",
  "description": "Updated description",
  "category": "updated_category",
  "tags": ["tag1", "tag2"]
}
```

Response: `200` with `{ ok: true, result: Control }`

---

**DELETE /controls/:id**
Delete a control.

Response: `200` with `{ ok: true, result: undefined }`

---

#### Frameworks

**POST /frameworks**
Create a new framework.

Request body:
```json
{
  "name": "SOC 2 Type II",
  "version": "2022",
  "description": "SOC 2 Type II compliance",
  "requirements": [
    {
      "requirementId": "CC6.1",
      "controlIds": ["ctrl_123", "ctrl_456"],
      "name": "Logical Access Controls"
    }
  ]
}
```

Response: `201` with `{ ok: true, result: Framework }`

---

**GET /frameworks**
List all frameworks.

Response: `200` with `{ ok: true, result: Framework[] }`

---

**GET /frameworks/:id**
Get a framework by ID.

Response: `200` with `{ ok: true, result: Framework }` or `404` with `FRAMEWORK_NOT_FOUND`

---

**PATCH /frameworks/:id**
Update a framework.

Request body (all fields optional):
```json
{
  "name": "Updated name",
  "version": "2023",
  "description": "Updated description",
  "requirements": [ ... ]
}
```

Response: `200` with `{ ok: true, result: Framework }`

---

**DELETE /frameworks/:id**
Delete a framework.

Response: `200` with `{ ok: true, result: undefined }`

---

#### Evidence

**POST /evidence**
Create evidence for a control.

Request body:
```json
{
  "controlId": "ctrl_123",
  "type": "manual_attestation",
  "actorId": "user_456",
  "outcome": "pass",
  "payload": { "note": "Access review completed" },
  "timestamp": 1234567890000
}
```

Response: `201` with `{ ok: true, result: Evidence }`

Evidence types:
- `automated_secfn`, `automated_authfn`, `automated_logfn`, `automated_watchfn`
- `automated_hostfn`, `automated_flowfn`, `automated_filefn`, `automated_plugfn`
- `manual_attestation`, `file_upload`, `questionnaire`, `custom_check`
- `scoping_decision`, `external_webhook`

---

**GET /evidence**
List evidence. Supports optional query parameters:
- `controlId` - Filter by control ID
- `frameworkId` - Filter by framework ID
- `type` - Filter by evidence type
- `since` - Filter by timestamp (Unix milliseconds)

Response: `200` with `{ ok: true, result: Evidence[] }`

---

**GET /evidence/:id**
Get evidence by ID.

Response: `200` with `{ ok: true, result: Evidence }` or `404` with `EVIDENCE_NOT_FOUND`

---

#### Checks

**POST /checks**
Create a check definition.

Request body:
```json
{
  "name": "RBAC Check",
  "controlId": "ctrl_123",
  "schedule": "daily",
  "adapterName": "secfn",
  "adapterMethod": "getRbacStatus"
}
```

Response: `201` with `{ ok: true, result: CheckDefinition }`

---

**GET /checks**
List all checks.

Response: `200` with `{ ok: true, result: CheckDefinition[] }`

---

**GET /checks/:id**
Get a check by ID.

Response: `200` with `{ ok: true, result: CheckDefinition }` or `404` with `CHECK_NOT_FOUND`

---

**POST /checks/:id/run**
Run a check immediately.

Response: `200` with `{ ok: true, result: RunCheckResult }`

```json
{
  "checkId": "chk_123",
  "controlId": "ctrl_456",
  "evidenceId": "evid_789",
  "outcome": "pass",
  "timestamp": 1234567890000
}
```

---

**DELETE /checks/:id**
Delete a check.

Response: `200` with `{ ok: true, result: undefined }`

---

#### Readiness

**GET /readiness/control/:controlId**
Get readiness status for a control. Supports optional query parameter:
- `frameworkId` - Scope readiness to a specific framework

Response: `200` with `{ ok: true, result: ControlReadiness }`

```json
{
  "controlId": "ctrl_123",
  "status": "compliant",
  "lastEvidenceAt": 1234567890000,
  "lastEvidenceId": "evid_456",
  "requirementIds": ["CC6.1", "CC6.2"]
}
```

Status values: `compliant`, `not_compliant`, `not_applicable`

---

**GET /readiness/framework/:frameworkId**
Get readiness status for a framework.

Response: `200` with `{ ok: true, result: FrameworkReadiness }`

```json
{
  "frameworkId": "fw_123",
  "status": "compliant",
  "controlReadiness": [ ... ],
  "lastUpdated": 1234567890000
}
```

---

#### Export

**POST /export/auditor-pack**
Export an auditor pack.

Request body (all fields optional):
```json
{
  "frameworkId": "fw_123",
  "since": 1234567890000
}
```

Response: `200` with `{ ok: true, result: AuditorPack }`

```json
{
  "exportedAt": 1234567890000,
  "frameworkId": "fw_123",
  "controls": [ ... ],
  "frameworks": [ ... ],
  "evidence": [ ... ],
  "mapping": [
    { "requirementId": "CC6.1", "controlIds": ["ctrl_123"] }
  ]
}
```

---

## CLI

CompFn provides a command-line interface for common operations.

### Configuration

Create a `compfn.config.json` file:

```json
{
  "database": {
    "type": "memory"
  },
  "namespace": "compfn",
  "systemActorId": "system"
}
```

Or set the `COMPFN_CONFIG` environment variable to point to your config file.

### Commands

#### `compfn init`

Initialize the database schema.

```bash
compfn init
compfn init --config /path/to/config.json
```

Options:
- `-c, --config <path>` - Path to config file (default: `compfn.config.json` or `$COMPFN_CONFIG`)

---

#### `compfn run-checks`

Run all compliance checks or a specific check.

```bash
compfn run-checks
compfn run-checks --check-id chk_123
```

Options:
- `--check-id <id>` - Run a specific check by ID
- `-c, --config <path>` - Path to config file

Output:
```
Ran 3 checks: 2 pass, 1 fail
```

---

#### `compfn export`

Export an auditor pack to a file or stdout.

```bash
compfn export --output report.json
compfn export --framework-id fw_soc2 --output soc2-report.json
```

Options:
- `--framework-id <id>` - Export for a specific framework (optional)
- `--output <path>` - Output file path (default: stdout)
- `-c, --config <path>` - Path to config file

---

#### `compfn attest`

Create a manual attestation evidence record.

```bash
compfn attest --control-id ctrl_123 --actor-id user_456
compfn attest --control-id ctrl_123 --actor-id user_456 --outcome pass
```

Options:
- `--control-id <id>` - Control ID (required)
- `--actor-id <id>` - Actor ID (required)
- `--outcome <pass|fail>` - Outcome (default: `pass`)
- `-c, --config <path>` - Path to config file

Output:
```
Attestation created: evid_789
```

---

## Evidence Adapters

CompFn supports pluggable evidence adapters for integrating with superfunctions:

```typescript
import { compFn, createSecfnAdapter } from "@superfunctions/compfn";

const api = compFn({
  database: db,
  adapters: {
    secfn: createSecfnAdapter({ secfnClient }),
    authfn: createAuthfnAdapter({ authfnClient }),
  },
});
```

## Framework Bundles

Load pre-defined framework bundles (SOC 2, ISO 27001, etc.):

```typescript
import { loadBundle } from "@superfunctions/compfn";

const bundle = await loadBundle("soc2-type2");
const framework = await api.frameworks.create(bundle.framework);
```

## Configuration

```typescript
const api = compFn({
  database: adapter,              // Required: @superfunctions/db adapter
  namespace: "compfn",            // Optional: table prefix
  systemActorId: "system",        // Optional: actor ID for automated checks
  readinessWindowDays: 90,        // Optional: freshness window for compliance
  evidencePayloadMaxBytes: 524288, // Optional: 512 KiB default
  retentionDays: 2555,            // Optional: 7 years default
  exportMaxBytes: 52428800,       // Optional: 50 MiB default
  adapters: { ... },              // Optional: evidence adapters
  logger: customLogger,           // Optional: custom logger
});
```

## Provider API: Consuming CompFn

CompFn can be consumed by other superfunctions (productFn, userfn, flowfn) to display compliance status and evidence-due tasks. The `readiness` and `evidence` APIs provide all the data needed to implement:

- **Compliance status widget**: Show framework readiness (compliant/not compliant/not applicable)
- **Evidence-due tasks**: List controls that need attention (no recent evidence or old evidence)
- **Attestation workflows**: Prompt users to submit manual attestations

### Getting Framework Readiness

Use `readiness.forFramework(frameworkId)` to get overall compliance status:

```typescript
const readinessRes = await api.readiness.forFramework("fw_soc2");
if (!readinessRes.ok) {
  console.error("Failed to get readiness:", readinessRes.error);
  return;
}

const { status, controlReadiness, lastUpdated } = readinessRes.result;
console.log(`Framework status: ${status}`);
console.log(`Last updated: ${new Date(lastUpdated).toISOString()}`);

controlReadiness.forEach((cr) => {
  console.log(`Control ${cr.controlId}: ${cr.status}`);
  if (cr.lastEvidenceAt) {
    console.log(`  Last evidence: ${new Date(cr.lastEvidenceAt).toISOString()}`);
  }
});
```

### Computing Evidence-Due Controls

To find controls that need attention ("evidence due"), filter `controlReadiness` by:
- Controls with no evidence (`lastEvidenceAt` is undefined)
- Controls with old evidence (`lastEvidenceAt < threshold`)
- Exclude controls marked as `not_applicable`

```typescript
const readinessRes = await api.readiness.forFramework("fw_soc2");
if (!readinessRes.ok) return;

const threshold = Date.now() - 90 * 24 * 60 * 60 * 1000;

const evidenceDue = readinessRes.result.controlReadiness.filter((cr) => {
  if (cr.status === "not_applicable") return false;
  if (!cr.lastEvidenceAt) return true;
  return cr.lastEvidenceAt < threshold;
});

console.log(`${evidenceDue.length} controls need evidence`);
evidenceDue.forEach((cr) => {
  console.log(`- Control ${cr.controlId} (last evidence: ${cr.lastEvidenceAt ? new Date(cr.lastEvidenceAt).toISOString() : "never"})`);
});
```

### Listing Recent Evidence

Use `evidence.list({ since })` to get all recent evidence across controls:

```typescript
const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
const evidenceRes = await api.evidence.list({ since: ninetyDaysAgo });
if (!evidenceRes.ok) return;

console.log(`${evidenceRes.result.length} evidence records in last 90 days`);
evidenceRes.result.forEach((e) => {
  console.log(`- ${e.type} for control ${e.controlId}: ${e.outcome}`);
});
```

You can also filter by control or framework:

```typescript
const evidenceRes = await api.evidence.list({
  controlId: "ctrl_123",
  since: Date.now() - 30 * 24 * 60 * 60 * 1000,
});
```

### Example: Building a "Tasks Due" View

```typescript
async function getComplianceTasks(frameworkId: string): Promise<Array<{ controlId: string; task: string }>> {
  const readinessRes = await api.readiness.forFramework(frameworkId);
  if (!readinessRes.ok) return [];

  const threshold = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const tasks: Array<{ controlId: string; task: string }> = [];

  for (const cr of readinessRes.result.controlReadiness) {
    if (cr.status === "not_applicable") continue;

    if (!cr.lastEvidenceAt) {
      tasks.push({
        controlId: cr.controlId,
        task: "No evidence submitted. Submit attestation or run check.",
      });
    } else if (cr.lastEvidenceAt < threshold) {
      const daysOld = Math.floor((Date.now() - cr.lastEvidenceAt) / (24 * 60 * 60 * 1000));
      tasks.push({
        controlId: cr.controlId,
        task: `Evidence is ${daysOld} days old. Submit new attestation or run check.",
      });
    }
  }

  return tasks;
}
```

### Creating Attestation Tasks

When a user needs to attest, create evidence via `evidence.create`:

```typescript
const attestationRes = await api.evidence.create({
  controlId: "ctrl_access_review",
  type: "manual_attestation",
  actorId: userId,
  outcome: "pass",
  payload: {
    note: "Q4 access review completed. All users reviewed and approved.",
    reviewDate: "2024-01-15",
  },
});

if (attestationRes.ok) {
  console.log("Attestation recorded:", attestationRes.result.id);
}
```

### Summary

The Provider API pattern is:

1. **Get readiness**: `readiness.forFramework(frameworkId)` → overall status + per-control readiness
2. **Filter evidence-due**: Find controls with `lastEvidenceAt < threshold` or no evidence
3. **List evidence**: `evidence.list({ controlId?, since? })` → recent evidence for display
4. **Create attestations**: `evidence.create({ type: "manual_attestation", ... })` → record user actions

This allows productFn, userfn, and flowfn to build:
- Compliance dashboards (readiness status)
- Task lists (evidence-due controls)
- Attestation forms (manual evidence creation)
- Scheduled reminders (flowfn triggers based on evidence age)

## License

MIT
