# Explicit HTTP authentication policy

Protected TypeScript HTTP routes now deny access when auth is omitted, empty, or lacks
a nonempty key/provider. `/ingest`, `/query` and `/issues/status` return 401 before
body parsing or storage access. Intentional anonymous hosts must explicitly configure
`auth: { enabled: false }`. `/health` remains public; trusted programmatic ingestion and
query retain their existing access. This changes the previous implicit anonymous HTTP
default and is documented as a host configuration migration.

A configured shared AuthProvider still takes precedence, with no legacy-key fallback.
Its per-operation scopes, expiry checks and sanitized failures are unchanged. Static
Bearer and x-api-key credentials retain their either-header compatibility and compare
fixed-size SHA-256 digests using Node timingSafeEqual, including unequal-byte-length
inputs. This does not claim constant-time behavior of the entire HTTP request path.

Validation on Node 20.20.0:

- New default-policy suite first reproduced three failures (absent auth, empty auth,
  empty key); after correction all six cases pass. It checks every protected route,
  unread malformed bodies, no downstream method access, explicit anonymous policy,
  public health, trusted programmatic read/write and full UTF-8 key comparisons.
- All six HTTP files pass: 68 tests, including provider precedence and scope tests.
- `npx turbo run lint test build --filter=@watchfn/core`: 270 tests / 27 files,
  TypeScript lint/types and ESM/CJS declarations pass; 12 tasks, no cache hits.
  Turbo used installed global 2.11.10 because this sparse checkout has no local binary.
- `npm exec --workspace=@watchfn/core -- vitest run --config
  tests/storage/sqlite.config.ts`: native SQLite persistence/reopen passed (one test).
  Existing anonymous storage and parsing fixtures now opt in explicitly; their original
  mutation, error, body-bound and readback assertions are retained.
- Fresh five-tarball ESM/CJS consumers pass using normal npm11 installation via
  `npx --yes --package=npm@11 -c 'WATCHFN_NPM_CLI="$(command -v npm)" node
  watchfn/typescript/scripts/verify-auth-package.mjs'`. Installed checks exercise default
  denial, unread bodies, trusted APIs, static keys and scoped provider behavior.
  The first default-npm install failed internally with `edgesOut`; the npm11 run used
  no force or peer-dependency bypass. Both fixture attempts remove their owned consumers
  in finally blocks. No external provider calls were made.

Receipts: `/tmp/watch-auth-default-baseline.log`, `/tmp/watch-auth-focused.log`,
`/tmp/watch-auth-full.log`, `/tmp/watch-auth-sqlite.log`, `/tmp/watch-auth-packed.log`
and `/tmp/watch-auth-packed-npm11.log`. Python HTTP authorization and deployed host
rate/origin/provider lifecycle policy are not established by this TypeScript checkpoint.
