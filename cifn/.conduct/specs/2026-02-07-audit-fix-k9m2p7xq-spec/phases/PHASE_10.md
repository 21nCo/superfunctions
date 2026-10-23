# Phase 10 — Self-deployability artifacts (Docker Compose + hostfn option + docs)

## Phase goal (1 sentence)

Ship concrete deployment artifacts so CiFn (control plane + runner) can be deployed and operated on user-owned infrastructure using Docker Compose and hostfn.

## In scope

- Add a Docker Compose deployment option for:
  - control plane service
  - runner service
  - required dependencies (as needed for chosen adapters)
- Add a hostfn-based deployment option (example config + commands).
- Add documentation for required environment variables and required secrets (secfn-backed).
- Provide a minimal smoke-test procedure.

## Out of scope

- Kubernetes manifests (optional).
- High-availability topology (multi-replica) beyond basic Compose.

## Deliverables (explicit list of files/modules)

- Create (example locations; exact paths may vary but MUST be in-repo):
  - `cifn/deploy/docker-compose.yml` (or `cifn/docker-compose.yml`)
  - `cifn/deploy/README.md`
  - `cifn/deploy/hostfn.example.config.*` (example hostfn config)
- Modify:
  - `cifn/README.md` (link to deployment docs)

## Requirements covered

- DEPLOY-001
- DEPLOY-002

## Implementation tasks (ordered checklist)

- [ ] Docker Compose:
  - [ ] Define services, ports, and required env vars.
  - [ ] Provide default “memory adapters” profile for local smoke.
  - [ ] Provide “production adapters” profile that points to flowfn/filefn/secfn/log sinks (URLs/tokens).
- [ ] hostfn option:
  - [ ] Provide a working hostfn config example to deploy the same services.
  - [ ] Document required secrets and how to store them in secfn.
- [ ] Documentation:
  - [ ] Enumerate required env vars (control plane URL, API keys source, runner registration token source, adapter configs).
  - [ ] Provide “missing env var” behavior (fail fast) and troubleshooting section.
- [ ] Smoke test:
  - [ ] Document manual steps to run TV-DEPLOY-001 and TV-DEPLOY-002.

## Verification steps (exact commands or manual steps) and expected outcomes

- Manual:
  - Follow TV-DEPLOY-001 and confirm `/health` responds and a run can be created.
  - Follow TV-DEPLOY-003N and confirm missing env var fails fast.
- Expected:
  - Deployment docs are complete and self-contained.

## Stop condition (what to report back before starting the next phase)

Report:

- Paths of all deployment artifacts added.
- A short smoke-test transcript (commands + expected responses).

