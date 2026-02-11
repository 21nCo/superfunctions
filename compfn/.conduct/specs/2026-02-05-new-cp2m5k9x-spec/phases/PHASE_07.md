# PHASE_07: Evidence adapters (interface, secfn, authfn)

## Phase goal

Implement EvidenceAdapter interface usage in checks.run (already wired in Phase 04). Add secfn adapter and authfn adapter that implement EvidenceAdapter (name, runCheck(input)), calling secfn and authfn clients and returning AdapterEvidence with type automated_secfn and automated_authfn. Document adapter contract. Run check with secfn adapter and authfn adapter in tests (with mock clients if needed).

## In scope

- EvidenceAdapter: name, runCheck({ checkId, controlId, method?, customConfig? }): Promise<AdapterEvidence>
- Secfn adapter: calls secfn (or mock) for RBAC status / secret scan summary / security events; maps to AdapterEvidence with type "automated_secfn"
- Authfn adapter: calls authfn (or mock) for MFA/session/user info; maps to AdapterEvidence with type "automated_authfn"
- Check run uses config.adapters[adapterName]; runCheck() returns AdapterEvidence; result is persisted via evidence.create() by checks.run

## Out of scope

- logfn, watchfn, hostfn, flowfn, filefn, plugfn adapters (can be added later); real secfn/authfn SDK dependency (mock acceptable for unit tests)

## Deliverables

- `src/adapters/types.ts` – EvidenceAdapter interface (or use from types)
- `src/adapters/secfn.ts` – secfn adapter (accepts secfn client or config; returns AdapterEvidence)
- `src/adapters/authfn.ts` – authfn adapter (accepts authfn client or config; returns AdapterEvidence)
- Tests: TV-ADAPT-INTERFACE-001, TV-ADAPT-SECFN-001, TV-ADAPT-AUTHFN-001 (with mocks)

## Requirements covered

- ADAPT-001, ADAPT-002, ADAPT-003

## Implementation tasks

1. Document EvidenceAdapter: name (string), runCheck({ checkId, controlId, method?, customConfig? }) => Promise<AdapterEvidence>. AdapterEvidence MUST include type and outcome; it MAY include timestamp/payload/artifactRef/frameworkRequirementId.
2. Implement secfn adapter: name "secfn". runCheck(input): call secfn client (e.g. getRbacStatus(), getSecretScanSummary(), or mock); map to AdapterEvidence with type "automated_secfn" and outcome set.
3. Implement authfn adapter: name "authfn". runCheck(input): call authfn client (e.g. getMfaStatus(), getSessionPolicy(), or mock); map to AdapterEvidence with type "automated_authfn" and outcome set.
4. Ensure checks.run uses adapter.runCheck({ checkId, controlId, method, customConfig }) and persists result via evidence.create().
5. Write TV-ADAPT-INTERFACE-001 (compFn with mock adapter). TV-ADAPT-SECFN-001 (secfn adapter with mock client returns AdapterEvidence with type automated_secfn). TV-ADAPT-AUTHFN-001 (authfn adapter with mock client returns AdapterEvidence with type automated_authfn).

## Verification steps

- Run adapter tests; all TV-ADAPT-* pass.
- Check run with adapterName "secfn" creates evidence with type automated_secfn when adapter returns data.

## Stop condition

- Adapter interface, secfn adapter, authfn adapter implemented and tested; check run integrates adapters.
