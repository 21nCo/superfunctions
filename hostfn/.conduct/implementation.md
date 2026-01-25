# HostFn Implementation Plan (Draft)

Last updated: 2026-01-14  
Status: Planning  
Owner: Platform (Superfunctions)

## Dependencies / Pre-reqs
- Credentials/secrets flow via `secfn` + `authfn`.
- Observability/logging via `watchfn`/`logfn`.
- DNS/SSL/provider APIs via `plugfn` (Route53/Cloudflare/AWS/GCP/DO/Fly).
- Optional: `flowfn` for CI/CD orchestration hooks.

## Phase 0 — Discovery & Schema
- Document `hostfn.config` schema: project type, build steps, artifacts, targets, health checks, rollout strategy, env maps.
- Artifact manifest schema (assets/server/functions/images) and route manifest for functions.
- Align with existing CLI commands; define config validation.

## Phase 1 — Buildpack & Artifact Pipeline
- Implement framework detection (Next/Nuxt/SvelteKit/Remix/Vite/Static/Node).
- Build runner: execute detected build; collect outputs.
- Emit manifest: assets (hash, path), server bundle metadata, functions map (route → bundle), optional OCI refs.
- Tests: detection matrix; manifest correctness; monorepo workspace resolution.

## Phase 2 — SSH Adapter (Baseline Deploy)
- Implement SSH deploy: upload artifacts, install systemd unit, configure Nginx/Caddy template, set env/secrets, health endpoint.
- Rollout: blue/green via dual systemd units and symlink swap; health + rollback.
- Commands: `deploy`, `status`, `logs -f`, `rollback`, `health`.
- Tests: local VM harness; idempotent apply; rollback on failed health.

## Phase 3 — Static + CDN Pipeline
- Static upload to S3-compatible (S3/Spaces/GCS) with hash manifests; caching headers.
- CDN config: CloudFront/Fastly/Cloudflare (start with CloudFront + Cloudflare); `cdn purge`.
- SPA fallback support; immutability for hashed assets.
- Tests: upload correctness, cache headers, purge behavior.

## Phase 4 — Cloud Adapters (Servers)
- AWS: EC2 + ALB + ASG; CloudFront for static; user-data with artifact fetch; health checks.
- GCP: GCE + HTTPS LB + MIG + CDN; artifact fetch on boot.
- DO: Droplets + cloud-init; Spaces + CDN.
- Fly.io: OCI deploy; health checks.
- Tests: mocked provider APIs for plan/apply; dry-run; ensure idempotency.

## Phase 5 — Functions Runtime
- Route manifest to provider mapping (Lambda/Cloud Run first).
- Bundle per-function (Node 18+); environment injection.
- Traffic + rollback for functions (versioned aliases).
- Tests: sample functions app deploy; invoke health; rollback.

## Phase 6 — Domains & SSL
- DNS management via plugfn (Route53/Cloudflare/etc.).
- ACME/Let’s Encrypt automation; renewals; wildcard if supported.
- Commands: `domains add`, `domains ls`, `cert renew`.
- Tests: stubbed ACME flow; DNS record application.

## Phase 7 — Traffic Policies & Health Gates
- Blue/green and canary with percentage + time window; automated rollback on failed checks.
- Health endpoints configurable; warmup; max-error thresholds.
- Tests: simulated failure triggers rollback.

## Phase 8 — Env/Secrets & Preview Envs
- `env pull/push`, `secrets set/unset` integrated with secfn.
- Preview deployments per branch (isolated domain, env).
- Tests: per-env injection; preview isolation.

## Phase 9 — Observability & UX
- Emit deploy lifecycle events to watchfn; wire logs to logfn.
- CLI UX polish: rich status, suggestions, dry-run summary.
- Docs/examples: static site, Node server, functions sample, monorepo config.

## Milestones
- M1: Buildpack/manifest + SSH deploy stable.
- M2: Static + CDN pipeline.
- M3: Cloud adapters (AWS/GCP/DO/Fly) for servers.
- M4: Functions runtime (Lambda/Cloud Run).
- M5: Domains/SSL + traffic policies (blue/green/canary).
- M6: Preview envs, secrets/env sync, observability polish.
