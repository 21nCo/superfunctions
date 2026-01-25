# HostFn Specification (Draft)

Last updated: 2026-01-14  
Status: Draft (not implemented)  
Owner: Platform (Superfunctions)

## Goal
Extend `hostfn` into a self-hosted, provider-agnostic hosting and deployment platform with a strong CLI—covering static sites, Node app servers, and serverless/edge-style functions—so teams can deploy to any VM or cloud without paying for thin DX layers (Vercel/Netlify-style convenience, but self-owned).

## Scope (v1)
- Buildpack-style project detection (Next/Nuxt/SvelteKit/Remix/Vite/Static/Node server).
- Build + package:
  - Static assets with manifest.
  - Node server bundle (zip/tar/OCI).
  - Functions bundle with route manifest (Node 18+).
- Deploy targets (adapters):
  - Generic SSH (systemd + Nginx/Caddy template).
  - AWS EC2 + ALB + CloudFront (static assets to S3).
  - GCP GCE + HTTPS LB + CDN (static to GCS).
  - DO Droplets + Spaces + CDN.
  - Fly.io (OCI).
  - Generic Kubernetes (later phase).
- Traffic policies: blue/green + canary with health checks and automatic rollback.
- Domains/SSL: DNS integration + Let’s Encrypt automation.
- Env/secrets: pull from `secfn`/`authfn`, inject at build or runtime.
- Observability: logs/metrics/health to `watchfn` and `logfn`.
- Preview environments per branch (static + server).

## Non-Goals (v1)
- Fully managed databases/queues (can provision via provider APIs but not operate them).
- Native mobile builds.
- Deep edge worker runtime (basic edge/worker adapter is later).

## Architecture
- CLI (extends existing hostfn CLI):
  - Commands: `init`, `build`, `deploy`, `status`, `logs`, `rollback`, `scale`, `env pull/push`, `secrets set/unset`, `domains add`, `cdn purge`, `health check`, `preview`, `expose`.
  - Config: `hostfn.config.(ts|json)` describing project type, build commands, artifacts, targets, health checks, rollout strategy, env maps.
- Automation clients (control-plane API, optional):
  - TypeScript and Python lightweight clients to call deploy/status/logs/env/secrets endpoints for CI/CD or programmatic orchestration when shelling out to the CLI is undesirable. Thin wrappers only; no runtime SDK.
- Buildpack/detection:
  - Detect framework/workspace; run build; emit artifact manifest (assets, server bundle, functions, routes).
- Packaging:
  - Static → upload set + hash manifest.
  - Server → zip/tarball or OCI (with Procfile-ish metadata).
  - Functions → per-function bundles + route manifest.
- Deployment adapters:
  - SSH: upload artifacts, install systemd unit, configure Nginx/Caddy; set up health endpoint.
  - AWS: EC2 AMI/UserData, ALB target groups, ASG, S3 static, CloudFront CDN.
  - GCP: GCE instance template/MIG, HTTPS LB, GCS static, CDN.
  - DO: Droplets with cloud-init, Spaces for static, CDN endpoint.
  - Fly: deploy OCI, map services; health checks.
  - K8s (later): apply manifests for Deployment/Service/Ingress; use route manifest for functions if supported.
- Traffic management:
  - Health checks, warmup, blue/green; canary by % with time window; auto-rollback on failed SLO.
- Domains/SSL:
  - DNS via `plugfn` DNS providers (Cloudflare/Route53/etc.).
  - ACME/Let’s Encrypt automation; renewals; wildcard optional.
- Observability:
  - Ship deploy events, health, and logs to `watchfn`/`logfn`.
  - Basic dashboards (deploy history, health status).
- CDN/cache:
  - Static assets to S3/GCS/Spaces; configure CDN; `cdn purge` command.

## Data/Config Model (high level)
- Project config: name, type (static/server/functions/mixed), build steps, output paths, routes, env mappings (dev/preview/prod), health checks, rollout strategy, targets.
- Artifact manifest: assets (hash, path), server bundle info, functions manifest (route -> bundle), image references (if OCI).
- Target config: provider, region, instance size, scaling policy (min/max), LB/CDN settings, DNS records, SSL policy.

## Integrations / Dependencies
- `watchfn`: health/metrics/log events; deploy event tracking.
- `logfn`: centralized log shipping (optional).
- `secfn` + `authfn`: secrets/env + tenant/auth for control plane.
- `plugfn`: DNS/SSL/provider API calls (AWS/GCP/Azure/DO/Cloudflare/Fly).
- `cachefn` patterns for CDN caching rules (optional).
- `flowfn` (optional) for CI/CD pipeline orchestration and notifications.

## Security & Safety
- Per-target credentials via `secfn`; never store in plain config.
- Health/rollback gates; idempotent apply for infra changes.
- SSH adapter uses non-root, systemd, firewall rules.
- Audit logs for deploys and rollbacks.

## Testing Strategy
- Unit: buildpack detection, manifest generation, config validation.
- Integration: dry-run deploy per adapter (mocked provider APIs); health/rollback flow; CDN upload.
- E2E (where feasible with local/SSH adapter): build → deploy → health → rollback.
- Load: large asset upload, concurrent deploys; ensure resumable uploads.

## Roadmap (phased)
- v0: Harden existing CLI; robust build detection; SSH adapter + static deploy to S3/Spaces with CDN.
- v1: Cloud adapters (AWS EC2/ALB/CloudFront; GCP GCE+LB+CDN; DO Droplets+CDN); blue/green + rollback; domains/SSL automation.
- v1.1: Functions manifest + Lambda/Cloud Run adapter; canary rollout; preview envs.
- v1.2: Fly.io + OCI path; CDN purge; secrets/env sync from secfn; log/metric hooks to watchfn/logfn dashboards.
- v1.3: Kubernetes adapter; drift detection; edge/worker adapter (CF Workers/Fly Machines) basics.
