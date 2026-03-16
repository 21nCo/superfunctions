# PlugFn Release Gates (Phase 00 Scaffold)

## Scope

This gate scaffold covers Phase 00 mapped requirements:

- `ARCH-002`
- `OPS-001`
- `OPS-002`

## Gate model

Each gate has:

1. Gate ID
2. Requirement mapping
3. Vector mapping
4. Command(s)
5. Pass criteria
6. Fail behavior
7. Baseline status (Phase 00)

## Gates

### GATE-ARCH-002-SHARED-OAUTH

- Requirement mapping: `ARCH-002`
- Vector mapping: `TV-ARCH-SHARED-USE-POS`, `TV-ARCH-SHARED-USE-NEG`
- Commands:

```bash
rg -n "from '@superfunctions/oauth-" /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src
rg -n "from '../auth/oauth-flow|MemoryTokenStore" /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/core /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/auth
```

- Pass criteria:
  - At least one shared OAuth import is present.
  - Legacy duplication pattern grep returns zero matches.
- Fail behavior:
  - Return `ERR_LEGACY_OAUTH_DUPLICATION` and block release.
- Baseline status (Phase 00): `FAIL`.
  - Reason: no shared package imports yet; legacy patterns present.

### GATE-OPS-001-PLUGFN-HARDENING

- Requirement mapping: `OPS-001`
- Vector mapping: `TV-OPS-HARDEN-POS`, `TV-OPS-HARDEN-NEG`
- Commands:

```bash
cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run
```

- Pass criteria:
  - Zero failed tests in required suite.
  - Regression paths for previously failing scenarios are covered.
  - No placeholder critical-path behavior remains.
- Fail behavior:
  - Any test failure blocks release.
  - Placeholder critical-path commands block release.
- Baseline status (Phase 00): `FAIL`.
  - Reason: 3 failed tests in `tests/basic.test.ts`; CLI test command still placeholder.

### GATE-OPS-002-CROSS-WORKSPACE-MATRIX

- Requirement mapping: `OPS-002`
- Vector mapping: `TV-OPS-MATRIX-POS`, `TV-OPS-MATRIX-NEG`
- Command:

```bash
cd /Users/serro/Documents/dev/n/superfunctions
turbo run build test --filter=@superfunctions/oauth-core --filter=@superfunctions/oauth-http --filter=@superfunctions/oauth-storage --filter=@superfunctions/oauth-providers --filter=plugfn --filter=@authfn/core
```

- Pass criteria:
  - All required workspace build and test tasks succeed.
  - OAuth connection and callback test scenarios pass in automation.
- Fail behavior:
  - Any failed workspace task returns `ERR_RELEASE_GATE_FAILED` and blocks release.
- Baseline status (Phase 00): `FAIL`.
  - Reason: shared OAuth workspaces not yet created and `plugfn` baseline tests currently failing.

## Execution order

1. Run `GATE-ARCH-002-SHARED-OAUTH` first.
2. Run `GATE-OPS-001-PLUGFN-HARDENING` second.
3. Run `GATE-OPS-002-CROSS-WORKSPACE-MATRIX` last.

Release may proceed only when all three gates pass in a single evidence run.

## Evidence requirements

1. Save command output logs per gate under a phase-specific evidence folder.
2. Include timestamps and git commit hashes in gate execution records.
3. Keep gate logs append-only for auditability.

## Runbook links for release artifacts

1. `docs/runbooks/oauth-incident.md`
2. `docs/runbooks/provider-throttle-incident.md`
3. `docs/runbooks/webhook-security-incident.md`
4. `docs/runbooks/mail-delivery-incident.md`
