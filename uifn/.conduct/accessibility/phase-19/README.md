# Phase 19 human accessibility evidence

This directory defines the fail-closed handoff for authentic VoiceOver, NVDA, TalkBack, and independent-review evidence.

## Trust boundary

- The 276-row matrix is generated from the reviewed Phase 18 handoff: 69 primitives across VoiceOver macOS, VoiceOver iOS, NVDA Windows, and TalkBack Android.
- Every row covers React, Svelte, and Solid in package and source modes on the exact frozen release candidate.
- Every execution separately records all 705 primitive-mode declarations plus every canonical state and event; a generic row-level pass cannot hide missing error, edge, dynamic, destructive, modal, form, or interaction-state coverage.
- Safari current and previous, Firefox plus Chrome or Edge, and physical iOS/Android evidence are mandatory as declared by the profile.
- Participant identities and public keys are accepted only from a registry signed by an externally provisioned accessibility-program trust root. Repository-local self-registration is not a trust root.
- Human evidence and the independent assessment use detached Ed25519 signatures. Automation-created or unsigned files are rejected.
- The independent reviewer must be distinct from implementation owners and every manual tester.
- JAWS remains exactly `not-tested-user-deferred`; no passing support claim is inferred.

Templates are deliberately marked `template-not-evidence`. Generating them does not execute a manual test, create a signature, or satisfy Phase 19.

## Capture order

1. Freeze one clean release-candidate commit, rerun Phase 18, and preserve its exact evidence.
2. Complete and cryptographically verify all 35 Phase 14 compatibility cells for the same tarball set.
3. Independently provision and pin the authority root, then complete and sign `participants.json`.
4. For every matrix row, expand the manual template into all required real sessions and every React/Svelte/Solid package/source execution.
5. Record each exact script step plus every required mode, state, and event observation. Copying DOM/axe output or using generated prose is not a human observation.
6. Link every affected defect. A closed or verified defect requires a passing human-observed retest after defect creation and within the signed row's execution interval.
7. After all 276 rows validate, the distinct reviewer completes the family samples, exact defect dispositions, and a one-to-one human retest inside the review interval for every closed or verified review finding.
8. Complete the ten confidence gates and final signed assessment.
9. Run `verify:uifn-phase-19`. Any source/artifact change invalidates the affected evidence and requires rerun/retest.

## Required verifier inputs

- `UIFN_PHASE19_EVIDENCE_DIR`
- `UIFN_PHASE19_PHASE18_EVIDENCE`
- `UIFN_PHASE19_TRACE_RUN`
- `UIFN_PHASE19_COMPAT_EVIDENCE_DIR`
- `UIFN_PHASE19_TRUST_ROOT_PUBLIC_KEY`
- `UIFN_PHASE19_TRUST_POLICY` (defaults to the repository-pinned Phase 19 trust policy)
- `UIFN_PHASE19_PARTICIPANTS` (defaults to `participants.json` in the evidence directory)

Manual rows belong in `manual/*.json`, defects in `defects/*.json`, and the independent assessment in `independent-review.json`.

Use `npm run sign:uifn-phase-19 -- --kind <participants|manual|review> --input <unsigned.json> --output <signed.json> --private-key <external-private.pem> --public-key <public.pem> --signed-by <participant-id>` to create a detached signature. The signer rejects templates, repository-resident private keys, permissive private-key permissions, overwrites, identity mismatches, and signatures that fail immediate verification.
