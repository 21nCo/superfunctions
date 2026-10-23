# Phase goal

Close production readiness with lifecycle security controls, observability hardening, runbooks, docs, and release gate execution.

## In scope / Out of scope

- **In scope**:
  - Retention/export/delete implementation and verification.
  - Redaction and tenant isolation audits.
  - E2EE mode metadata controls.
  - Runbooks, migration docs, and final matrix gate.
- **Out of scope**:
  - New product features beyond this spec.

## Deliverables

- `plugfn/typescript/src/security/retention.ts`
- `plugfn/typescript/src/security/export-delete.ts`
- `plugfn/typescript/src/security/redaction.ts`
- `plugfn/typescript/src/security/isolation-guards.ts`
- `plugfn/typescript/src/security/e2ee-mode.ts`
- `plugfn/typescript/tests/security/lifecycle.test.ts`
- `plugfn/typescript/tests/security/redaction.test.ts`
- `plugfn/typescript/tests/security/isolation.test.ts`
- `plugfn/docs/runbooks/oauth-incident.md`
- `plugfn/docs/runbooks/provider-throttle-incident.md`
- `plugfn/docs/runbooks/webhook-security-incident.md`
- `plugfn/docs/runbooks/mail-delivery-incident.md`
- `plugfn/docs/getting-started.md` (updated)
- `plugfn/typescript/README.md` (updated)
- `authfn/ts-sdk/README.md` (interop update)

## Requirements covered

- SEC-001
- SEC-002
- SEC-003
- SEC-004
- OPS-001
- OPS-002
- OPS-003
- OPS-004

## Implementation tasks

1. Implement retention/export/delete orchestration with cascades.
2. Enforce telemetry redaction and tenant isolation guards globally.
3. Add explicit managed-mailbox E2EE metadata and recovery mode handling.
4. Create and validate operational runbooks.
5. Execute full release matrix and capture evidence artifacts.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/security/lifecycle.test.ts tests/security/redaction.test.ts tests/security/isolation.test.ts`
2. `cd /Users/serro/Documents/dev/n/superfunctions && turbo run build test --filter=@superfunctions/oauth-core --filter=@superfunctions/oauth-http --filter=@superfunctions/oauth-storage --filter=@superfunctions/oauth-providers --filter=plugfn --filter=@authfn/core`
3. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn && rg -n "coming soon|placeholder implementation" docs typescript/README.md`
Expected outcome: security tests and matrix pass; no placeholder operational language remains.

## Stop condition

All security/ops requirements pass verification and release readiness evidence is recorded.
