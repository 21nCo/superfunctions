# Local flag prerequisites and environment overrides

2026-10-20. Implements the local prerequisite/environment portions of the original
UserFn specification's Flag model, SDK and Feature Flags sections. It extends
local bootstrap without claiming a configuration server, signed/ETag delivery,
background refresh or exposure transport.

## Configuration contract

TypeScript adds `FlagPrerequisite { key, expectedValue }`, optional
`FlagConfig.prerequisites`, `FlagEnvironmentOverride`, optional
`FlagConfig.environmentOverrides`, and `UserFnOptions.environment`. Python exposes
`FlagPrerequisite(key, expected_value)`, `FlagEnvironmentOverride`,
`FlagConfig.prerequisites`, `FlagConfig.environment_overrides`, and
`UserFnOptions.environment`. These are native SDK configuration types; this
checkpoint does not introduce a general camelCase/snake_case wire codec.

Every prerequisite must be available and its evaluated value must equal the
expected JSON value. Objects compare without key-order dependence; arrays remain
ordered; booleans, strings and numbers remain distinct. False, zero, empty strings,
arrays and objects are valid expected values. Python numeric comparison uses
finite float/IEEE-754 representation to match JavaScript JSON numbers, with
OverflowError/nonfinite rejection. Native Python arbitrary-precision integers
are outside shared exact numeric precision; encode exact large IDs as strings.
Tests distinguish the safe-integer boundary and confirm JavaScript rounding above
it. No string-to-number or boolean-to-number coercion is performed.

Missing, disabled, unmet and cyclic dependencies make the requested flag
unavailable: `getFlag/get_flag` returns that call's supplied fallback, not the
flag's configured default or a dependency's fabricated fallback. For example,
a missing dependency cannot satisfy `expectedValue: false`. This is not a forced
boolean false return: applications must choose an appropriate fallback for gated
features. Unrelated valid flags remain available. All prerequisites are ANDed.

Evaluation uses iterative DFS with per-call outcomes and cycle detection. It is
independent of definition insertion order and does not recurse through dependency
chains; 5,000-node chains are covered. Each dependency sees the same current user
and environment, and no outcome cache survives across users, identity resets,
configuration replacements or calls. Existing segments, inline constraints,
ordered rules, anonymous-user behavior and rollout percentage logic remain in
place. Environment is not added to the hash salt; a user's existing bucket stays
stable when an environment changes the percentage.

Environment names are exact, case-sensitive, nonempty strings. Missing/unknown
environments inherit the base flag. Only own TypeScript mapping entries are used,
including literal `__proto__` names; inherited `constructor`/`toString` entries
are never overrides. Overrides may replace `enabled`, `defaultValue`,
`defaultVariationId`, and the complete ordered rule array. Omitted fields inherit;
empty rule arrays explicitly replace base rules. Null/None for an override's
default variation explicitly clears it. Python uses an internal omission sentinel
to distinguish omitted default value/variation from explicit values; normal
construction does not require importing the sentinel. Base default variations
continue to take precedence unless replaced/cleared.

Base `enabled: false` remains a global kill switch: environment `enabled: true`
cannot resurrect it. An environment can additionally disable a globally enabled
flag. Variations and prerequisites are shared; overrides cannot remove dependency
gates or invent a second variation namespace.

## Validation and mutation boundaries

Definition replacement validates before modifying evaluator state. Invalid
replacements raise TypeError and preserve prior definitions. Duplicate/empty keys,
malformed prerequisite/override structures, unknown variation references,
out-of-range/nonfinite rollouts, unsupported constraint operators, cyclic JSON,
nonfinite values and unsupported value objects are rejected explicitly. Cycles or
missing nodes in the flag dependency graph are different: they are allowed to load
but resolve unavailable, supporting incomplete configurations without accidental
enablement. Known segment operators are preserved.

TypeScript configuration containers require plain enumerable data properties; accessors
and serialization hooks are rejected before invocation. Optional undefined data
properties remain supported. The serialized snapshot is validated again before
assignment.

Loaded definitions are snapshotted. Modifying input objects after `setFlags` does
not change evaluation, and returned structured flag values are copied so they
cannot alter future prerequisite decisions. Caller-supplied fallback objects
retain their existing caller-owned behavior. Segments keep their existing
configuration contract; this change is not a general segment parity rewrite.

Operator save and enable-toggle paths use the same definition validator before
storage. The admin flag input/output schema now includes prerequisites,
environment overrides and the preexisting defaultVariationId field. Save, list
and global enable-toggle preserve them without dropping configuration. Tests use
the actual injected memory operator store and environment scope; this is not
proof of durable flag configuration storage. Shared dispatcher schemas are
validated explicitly; direct adapter invocation also reaches domain validation.

## Dependency and package closure

`@userfn/admin` now depends on the current shared `@superfunctions/admin` 0.1.5,
using local `@mcpfn/core` 0.0.6. A scoped npm workspace install and local builds
provided the actual dependencies. The root lock change is limited to the UserFn
admin dependency and removal of its obsolete nested admin/MCP/AJV graph; unrelated
npm optional/dev metadata churn was discarded. No shared source was changed.

A fresh installed CJS type consumer exposed the SDK's existing unconditional ESM
`types` export. Main and operator exports now select `.d.ts` for import and
`.d.cts` for require, matching the already generated runtime formats.

## Acceptance evidence

- TypeScript SDK: 68 source tests passed, production typecheck passed, CJS/ESM
  and declaration build passed (Node 20).
- Python 3.9.6: 68 source tests passed, plus a fresh built wheel installed in an
  isolated Python 3.12.12 environment: 68 tests passed; copied tests run against site-packages, without source
  pythonpath injection.
- Shared Unicode hash vectors and end-to-end environment-rollout prerequisites
  in both SDKs, including non-BMP and lone-surrogate IDs/keys. The separate
  [hash migration note](flag-hash-parity-readiness.md) documents changed Python
  non-BMP assignments; unchanged assignments are not claimed.
- Admin: 8 tests passed, including actual save/list/toggle and schema acceptance/
  rejection; typecheck and build passed with the local shared dependency closure.
- `typescript/scripts/verify-flag-context.mjs` packs SDK, UserFn admin, shared admin
  and MCP; installs all four tarballs in a fresh directory with normal dependency
  resolution; exercises ESM SDK/admin and CJS SDK runtime; then compiles installed
  `.mts` and `.cts` consumers under strict NodeNext without skipLibCheck or peer
  bypass. Temporary consumers are removed after the run.

Reproduce SDK/admin checks after building MCP/shared admin prerequisites:

```sh
npm run typecheck --prefix userfn/typescript
npm test --prefix userfn/typescript
python3 -m pytest userfn/python/tests -q
npm run build --prefix userfn/typescript
npm test --prefix userfn/admin
npm run typecheck --prefix userfn/admin
npm run build --prefix userfn/admin
node userfn/typescript/scripts/verify-flag-context.mjs
```

## Remaining original requirements

Durable flag/config service storage, authenticated publish/fetch, signing and
ETag refresh, automatic refresh scheduling, exposure delivery, evaluation
telemetry, feature-flag UI/hooks, broader segment parity/operators, flag owner/tag
administration and deployed/browser/load acceptance remain open. Existing
messaging, surveys/forms, feedback source integrations, roadmap/changelog and
other original UserFn requirements are not completed by this local evaluator
checkpoint. Dependency gates are feature configuration, not an authorization
boundary replacing server-side access control.

Subsequent server checkpoint: [signed configuration service](flag-config-service-readiness.md)
adds authenticated durable publication and signed/ETagged fetch. SDK transport,
verification, refresh and exposure requirements above remain open.
