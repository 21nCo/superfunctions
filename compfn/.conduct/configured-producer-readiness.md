# Configured AuthFn and SecFn source acceptance

2026-10-23. Base `08132fdfdd5860967c12d98edb68baa5ffceb1a7`.

CompFn's `AuthfnClient` and `SecfnClient` are application-supplied summary
interfaces. Neither producer exposes those same methods directly. The original
phase-07 spec explicitly permits mocks in unit tests and excludes a direct SDK
dependency; this acceptance adds a real, narrow local producer path without
inventing HTTP endpoints or claiming aggregate controls that producers do not expose.

## Supported source wiring

- AuthFn `core/src/core/cookies.ts:resolveCookiePolicy` is exposed by its package's
  `./core/*` export. It resolves configured/default session age and cookie policy.
  A configured CompFn `getSessionPolicy` bridge calls that implementation and
  supplies its actual 1,800-second result. CompFn persists the raw policy with
  outcome **unknown**: collecting configuration does not define a passing threshold.
- AuthFn's public server exposes router/provider/session operations, not an
  aggregate MFA enforcement query. Presence of its two-factor plugin or enrollment
  records is insufficient to assert global enforcement. This bridge omits
  `getMfaStatus`; the existing CompFn adapter persists **unknown**, never pass.
- SecFn `core/src/scanner/scanner.ts:createSecurityScanner` exposes `scanFile` and
  returns actual findings using its default rule pack. The configured CompFn bridge
  awaits a real file scan before producing a completed summary. The clean fixture
  produces zero findings/pass; a synthetic detector fixture produces findings/fail.
  A missing file fails, with error evidence rather than a false passing summary.
- `scanFile` deliberately skips files above `maxFileSize`, returning an empty array;
  `scanDirectory` also ignores unreadable files. Therefore an unqualified
  `findings.length === 0` is not complete repository scan evidence. The acceptance
  bridge controls immutable local fixture files, checks its explicit 4,096-byte
  limit and returns skipped/unknown for the oversized fixture. It does not claim
  this stat-then-scan example protects arbitrary concurrently modified files.
- SecFn server exposes access checks and audit services, but no general
  `getRbacStatus` summary. No RBAC/global-policy evidence is inferred here.

The path is actual producer implementation → application-owned summary client →
CompFn adapter → checks.run → evidence.create → shared Drizzle/native SQLite →
readiness. Only explicit clean-file scope becomes compliant. Five other cases
(finding, missing, oversized, policy-only, unavailable MFA) remain not compliant,
with fail/unknown evidence retaining the distinction.

## Reproduction and exact evidence

From the repository root, with ordinary scoped CompFn dependencies already
installed and the repository's `tsx` development executable available:

```sh
# Only needed in sparse worktrees; reads the tracked source at the current head.
git sparse-checkout add /authfn/core/ /secfn/core/
npm run build -w compfn
node_modules/.bin/tsc -p compfn/.conduct/configured-producer-tsconfig.json
node_modules/.bin/tsx compfn/.conduct/configured-producer-acceptance.mts
npm run typecheck -w compfn
npm test -w compfn
```

The integration script imports the checked-out AuthFn/SecFn source APIs and built
CompFn output. Its strict fixture typecheck resolves two missing type-only shared
AuthFn contracts directly to their checked-out sources via the explicit fixture
config. This is **source integration**, not an installed AuthFn/SecFn package,
packed consumer, whole-producer build or hosted service claim. CompFn has no
runtime dependency added on either producer. No peer/dependency bypass or package
manifest/lockfile change was made.

On Node 20.20.0 with better-sqlite3 12.5.0:

```json
{"status":"passed","cases":6,"outcomes":["pass","fail","fail","unknown","unknown","unknown"],"realFileScans":2,"realAuthPolicyResolutions":1,"sqliteReopenVerified":true}
{"cleanup":"verified","directoryRemoved":true}
```

The script closes SQLite, creates a new SQLite handle/shared adapter/CompFn
instance, and reads every evidence payload, outcome, check link and readiness
last-evidence ID back. Producer call counters prove those reads did not rescan or
recalculate policy. This is file persistence across handle/instance reopen, not
an abrupt process-kill durability test. All artifacts live in a uniquely owned OS
temporary directory; finally closes the handle, deletes the directory and verifies
ENOENT. The synthetic credential-looking string is not issued or sent anywhere;
only count/status is persisted, never scanner matches or secret context.

Validation: core/CLI/admin typechecks and builds pass; **129 core tests across 16
files plus 8 admin tests across 2 files pass**. Strict integration fixture typecheck
and all 6 local source/persistence cases pass. Logs:
`/tmp/compfn-configured-producer-acceptance.log`,
`/tmp/compfn-producer-build.log`, `/tmp/compfn-producer-types.log`,
`/tmp/compfn-producer-tests.log`. The package is TypeScript; its spec makes Python
optional and there is no Python implementation changed or validated here.

No CompFn defect was reproduced by this integration, so no runtime behavior was
changed. Existing injected-summary completion tests remain valuable but are not
relabelled live-provider coverage. MFA enforcement, RBAC policy completeness,
full repository scan coverage, external providers, installed producer dependency
graph, deployment and the broader original readiness requirements remain open.
