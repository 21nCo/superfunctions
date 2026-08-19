# SFN-21 Issue Completion Report

## Metadata

- Timestamp: `2026-08-13T15:32:22Z`
- Agent: Codex
- Model: GPT-5 Codex
- Launcher: Codex Desktop
- Branch: `codex/super-console`
- Issue: SFN-21 — Super Console modular self-hosted administration control plane
- Verified implementation/lock commit: `078dfec7c1db1daa2a4cae965963c80a0e4cd994`
- Durable evidence: `superconsole/.conduct/SFN-21/evidence/final/`

## Status

**PASS**

This report supersedes the blocked historical report
`2026-08-13-08c93f37-completion.md`. The re-audit findings were reproduced and
remediated without narrowing the unchanged Linear acceptance contract.

## Requirements completed

- Built the self-hosted SvelteKit/Tailwind Super Console using public UIFn
  packages and source-fixed UIFn primitives.
- Made the deployment's explicit enabled-module registry authoritative for UI,
  dispatch, REST/OpenAPI, TypeScript clients, and McpFn discovery.
- Delivered 20 required, 6 optional, 2 nested, and 1 folded administration
  packages with no unavailable SFN-21 module.
- Added real operator boundaries for HostFn and UserFn and optional ApiFn,
  BotFn, DocsFn, and LangFn.
- Kept CatchFn and LogFn nested under WatchFn, ContentFn folded into CmsFn, and
  CiFn migrated into the shared shell using its control plane.
- Preserved customer-facing portals as separate from operator administration.
- Exposed the same function-owned capabilities through UI, language-neutral
  REST/OpenAPI, typed TypeScript clients, and McpFn tools.
- Closed typed scope/context, timeout/cancellation, raw response, terminal-audit
  reconciliation, one-time-secret path, and high-risk confirmation findings.
- Kept all delivery local in coherent commits; no push, PR, deployment, or
  publication was performed.

## Verification summary

- Shared admin kernel: typecheck/build PASS, 65/65 tests.
- All 29 admin workspaces: 29 typechecks, 122/122 tests, 29 builds PASS.
- Built contract: 29 manifests, 130 resources, 347 unique operations,
  `20/6/2/1` availability split.
- SDK contract: all built clients preserve common methods; independent review
  28/28 available/nested factories PASS.
- Mutation risk review: 58/58 PASS, zero exceptions.
- Super Console: Svelte check 0/0, 74/74 tests, production build PASS.
- UIFn governance: 10/10 PASS with the recorded repository baseline verdict
  preserved as `FAIL`.
- Owning runtimes: HostFn 63/63, UserFn 17/17, ApiFn 93/93, DocsFn 147/147,
  LangFn 56/56.
- Production browser smoke: `ok: true`, durable sanitized evidence bound to
  commit `078dfec7c1db1daa2a4cae965963c80a0e4cd994`.
- Lock regeneration second run stable at SHA-256
  `c88650b9cc5ab64a7e7a3d81abfeaa29766755ac2913e519d503191afdd96ee5`.

Full commands, evidence links, and external-proof boundaries are recorded in
`superconsole/.conduct/SFN-21/verification.md`.

## Blockers

None for the local SFN-21 acceptance contract. Remote CI, package publication,
production provider credentials, DNS, hosted durability, and a deployed
self-hosted installation remain outside this local task and are not claimed.
