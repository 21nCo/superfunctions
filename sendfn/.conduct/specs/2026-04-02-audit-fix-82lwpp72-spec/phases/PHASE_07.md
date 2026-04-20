# Phase goal

Align documentation, examples, and final verification evidence with the corrected production-ready public surface.

## In scope / Out of scope

- In scope:
  - README corrections
  - example alignment
  - webhook setup/operator notes
  - final release-gate rerun
- Out of scope:
  - new features not already specified in this bundle

## Deliverables

- `sendfn/typescript/README.md`
- `sendfn/python/README.md`
- `sendfn/python/examples/basic_email.py`
- `sendfn/python/examples/templates.py`
- `sendfn/python/examples/suppression.py`
- `sendfn/typescript/examples/basic-email.ts` (new)
- `sendfn/typescript/examples/custom-templates.ts` (new)
- `sendfn/typescript/examples/push-notification.ts` (new)
- `sendfn/typescript/examples/event-handling.ts` (new)

## Requirements covered

- `DOC-001`
- `PKG-001`
- `PKG-002`
- `PARITY-001`

## Implementation tasks

1. Remove package-name drift from docs and examples.
2. Remove misleading “coming soon” language for shipped features or downgrade the public surface if a feature remains unsupported after prior phases.
3. Document webhook signature verification requirements and the repo-root release-gate commands.
4. Update examples so they compile/import against the corrected public API.
5. Rerun the full release gate and record the final verification evidence.

## Verification steps

1. Run the full repo-root release gate from `PHASE_06`.
   - Expected outcome: all commands pass.
2. Validate `TV-DOC-001-P` and `TV-DOC-001-N`.
   - Expected outcome: docs/examples match shipped behavior and package names.
3. Optionally typecheck TypeScript examples if included in the workspace.
   - Expected outcome: example imports are valid.

## Stop condition

Stop after all docs and examples match the corrected public API and the final release gate passes without audit-blocking mismatches.
