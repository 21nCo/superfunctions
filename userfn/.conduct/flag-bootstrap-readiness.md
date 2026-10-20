# Local flag bootstrap

The existing TypeScript `bootstrapFlags` and Python `bootstrap_flags` options
were silently ignored. Both constructors now load resolved values as enabled
local flag definitions without targeting rules. Missing keys still use the
caller's fallback. TypeScript now exposes `setFlags` and `setSegments`, matching
the existing Python configuration methods, so public clients can replace the
bootstrap with targeting rules.

The SDK suites pass 32 tests each. New public-client tests cover false, zero,
empty strings, structured values, unknown keys, client isolation, configuration
surviving identity reset, complete replacement, segment targeting and clearing.
TypeScript also verifies literal prototype-like keys without inherited values.
TypeScript source typechecking and ESM/CJS/declaration builds pass. Direct consumers of both built module formats verify bootstrap values and replacement; this increment did not repeat fresh tarball installation.

These are local resolved values, not an authenticated remote configuration
service. Bootstrap values are not re-evaluated by user identity; the host must
supply appropriately scoped values or replace them with rules. Configuration
fetch, ETag/signing, refresh scheduling, exposure delivery, flag prerequisites
and environment overrides remain open original requirements. The broader
UserFn specification is incomplete.

The subsequent [flag context checkpoint](flag-context-readiness.md) implements local prerequisites and environment overrides; the other delivery and broader original requirements remain open.
