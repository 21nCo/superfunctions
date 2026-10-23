# PHASE 00

## Phase goal
Establish baseline workspace wiring, duplication guardrails, and release-gate scaffolding for this spec.

## In scope / Out of scope

- **In scope:** workspace entries, baseline scripts, duplication scan config, gate script scaffolding.
- **Out of scope:** functional OAuth/reuse code migrations.

## Deliverables

- Root workspace updates in `package.json`.
- Duplication check config/script (e.g., `scripts/check-duplication.mjs` and optional `.jscpd.json`).
- Release-gate script stub (`scripts/gate-audit-fix-o4u9k2m7.mjs`).
- CI task wiring for duplication and gate checks.

## Requirements covered

- OPS-001
- OPS-002
- OPS-004

## Implementation tasks

1. Add missing workspace entries for new packages and root docs.
2. Add duplication scan script with scoped ignore rules for build/vendor/test fixture noise.
3. Add release-gate script with package checklist placeholders.
4. Add npm scripts in root for `check:duplication` and `gate:audit-fix-o4u9k2m7`.
5. Add CI pipeline hooks invoking new scripts.

## Verification steps

1. Run:
```bash
npm run check:duplication
```
Expected: command runs and returns baseline report; threshold behavior is deterministic.

2. Run:
```bash
npm run gate:audit-fix-o4u9k2m7
```
Expected: script executes and reports pending requirements without runtime errors.

3. Run:
```bash
turbo run build --filter=docs --filter=@superfunctions/oauth-core
```
Expected: no workspace resolution failures.

## Stop condition
Commit-ready baseline guardrails exist and all verification commands complete successfully.
