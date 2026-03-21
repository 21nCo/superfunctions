# PHASE_09

- Phase goal: Harden the system around security, auth gating, analytics emission, watch or dev ergonomics, and fail-closed CLI behavior.

## In scope

- Content sanitization enforcement across framework layers.
- Optional auth gating contract using `authfn`.
- Opt-in analytics contract using `watchfn`.
- CLI `validate`, `build`, and `dev` behavior with structured diagnostics.

## Out of scope

- New authentication providers beyond the shared auth contract.
- CI pipeline authoring.
- Non-essential design refinements.

## Deliverables

- Create `docsfn/core/src/security.ts`.
- Create `docsfn/core/src/security.test.ts`.
- Create `docsfn/core/src/analytics.ts`.
- Create `docsfn/core/src/analytics.test.ts`.
- Modify `docsfn/core/src/diagnostics.ts`.
- Modify `docsfn/cli/src/index.ts`.
- Modify `docsfn/next/src/index.ts`.
- Modify `docsfn/sveltekit/src/index.ts`.
- Modify `docsfn/react/src/DocsContent.tsx`.
- Modify `docsfn/svelte/src/DocsContent.svelte`.

## Requirements covered

- `SEC-001`
- `OBS-001`
- `CLI-001`
- `CFG-001`

## Implementation tasks

1. Centralize the sanitization and trust model in `docsfn/core/src/security.ts` so all renderers and site kits enforce the same allowlist and diagnostics behavior.
2. Add optional auth gating primitives that let site kits mark docs trees or routes as public, private, or mixed using the canonical config model and `authfn` integration points.
3. Define opt-in analytics events and payload constraints for `watchfn`, including a hard rule that secrets, raw tokens, and PII never enter event payloads.
4. Refactor the CLI so `validate`, `build`, and `dev` all consume the same config, diagnostics, provider, manifest, and search pipelines, and exit non-zero on error-severity diagnostics.
5. Add watch or dev behavior that invalidates manifests and search artifacts only for the affected roots and surfaces readable diagnostics instead of silent failures.
6. Add tests for blocked raw scripts, auth mode misconfiguration, analytics payload validation, and CLI fail-closed behavior under invalid config or provider errors.
7. Ensure framework adapters surface auth and analytics hooks without forcing applications to enable either feature.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/core run test -- --run src/security.test.ts src/analytics.test.ts`
   Expected outcome: security and analytics rules pass and negative cases produce structured diagnostics.
2. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/cli run build -- validate --root /Users/serro/Documents/dev/n/superfunctions/docsfn/test-fixtures/repo/datafn-docs`
   Expected outcome: valid fixtures succeed with zero error-severity diagnostics.
3. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/cli run build -- validate --root /Users/serro/Documents/dev/n/superfunctions/docsfn/test-fixtures/invalid-script-fixture`
   Expected outcome: validation fails non-zero and reports the expected security diagnostic code.
4. Manual check: run `docsfn dev` against a canonical fixture and edit one content file.
   Expected outcome: only the affected content path is invalidated and diagnostics remain readable and structured.

## Stop condition

- Report the final auth modes and analytics event names exposed publicly.
- Report the CLI commands and exit-code semantics that are now canonical.
- Report any remaining security exceptions or allowlist decisions that need explicit approval before release.
