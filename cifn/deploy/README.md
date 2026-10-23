# CiFn Deployment Guide

Self-hosted deployment of the CiFn CI/CD system (control plane + runner).

## Prerequisites

- Node.js 20+ (for local/hostfn deployment)
- Docker and Docker Compose (for containerized deployment)
- Access to secfn for secret storage (production)

## Quick Start (Docker Compose — Local Smoke Test)

This profile uses **memory adapters** (no external dependencies required).

```bash
cd cifn/deploy

# 1. Copy and edit environment file
cp env.example .env

# 2. Set minimal required values in .env:
#    CIFN_API_KEYS=test-api-key
#    CIFN_RUNNER_REGISTRATION_TOKEN=test-reg-token
#    CIFN_RUNNER_ID=runner_1
#    CIFN_RUNNER_SECRET=rs_test123

# 3. Start services
docker compose up --build

# 4. Verify health
curl http://localhost:3100/health
# Expected: {"ok":true}

# 5. Create a test run
curl -X POST http://localhost:3100/api/v1/runs \
  -H "Authorization: Bearer test-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "pipelineSpec": {
      "name": "smoke-test",
      "on": { "workflow_dispatch": {} },
      "jobs": {
        "build": {
          "runs-on": "default",
          "steps": [{ "run": "echo hello" }]
        }
      }
    },
    "trigger": { "type": "workflow_dispatch", "payload": {} }
  }'
# Expected: {"ok":true,"data":{"runId":"...","status":"queued","createdAt":"..."}}
```

## Production Deployment (Docker Compose)

For production, set adapter types to `real` and provide the corresponding service URLs.

```bash
cd cifn/deploy
cp env.example .env
```

Edit `.env` with production values:

```env
CIFN_API_KEYS=<from-secfn>
CIFN_RUNNER_REGISTRATION_TOKEN=<from-secfn>
CIFN_WEBHOOK_SECRET=<from-secfn>

CIFN_QUEUE_ADAPTER=real
CIFN_ARTIFACTS_ADAPTER=real
CIFN_SECRETS_ADAPTER=real
CIFN_LOGS_ADAPTER=real

FLOWFN_BASE_URL=https://flowfn.your-infra.example.com
FLOWFN_API_KEY=<from-secfn>
FILEFN_BASE_URL=https://filefn.your-infra.example.com
FILEFN_API_KEY=<from-secfn>
SECFN_BASE_URL=https://secfn.your-infra.example.com
SECFN_API_KEY=<from-secfn>
LOGFN_BASE_URL=https://logfn.your-infra.example.com
LOGFN_API_KEY=<from-secfn>
```

Then start:

```bash
docker compose up --build -d
```

## hostfn Deployment

Use the provided hostfn config example to deploy on a hostfn-managed node.

### 1. Store secrets in secfn

```bash
# Required secrets
secfn set cifn.api_keys "your-api-key"
secfn set cifn.runner.registration_token "your-reg-token"
secfn set cifn.runner.id "runner_prod_1"
secfn set cifn.runner.secret "rs_prod_secret"

# Integration URLs
secfn set cifn.flowfn_base_url "https://flowfn.your-infra.example.com"
secfn set cifn.flowfn_api_key "your-flowfn-key"
secfn set cifn.filefn_base_url "https://filefn.your-infra.example.com"
secfn set cifn.secfn_base_url "https://secfn.your-infra.example.com"
secfn set cifn.secfn_api_key "your-secfn-key"
secfn set cifn.logfn_base_url "https://logfn.your-infra.example.com"
secfn set cifn.logfn_api_key "your-logfn-key"

# Optional
secfn set cifn.webhook.github "your-webhook-hmac-secret"
```

### 2. Deploy

```bash
# Copy the example config
cp deploy/hostfn.example.config.json hostfn.config.json

# Deploy to production
hostfn deploy production --ci

# Deploy to staging (uses memory adapters)
hostfn deploy staging --ci
```

### 3. Verify

```bash
curl https://cifn.your-infra.example.com/health
# Expected: {"ok":true}
```

## Environment Variables Reference

### Control Plane (Required)

| Variable | Description | Source |
|---|---|---|
| `CIFN_API_KEYS` | Comma-separated API keys for authenticating requests | secfn: `cifn.api_keys` |
| `CIFN_RUNNER_REGISTRATION_TOKEN` | Token for runner registration | secfn: `cifn.runner.registration_token` |

### Control Plane (Optional)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | HTTP listen port |
| `CIFN_WEBHOOK_SECRET` | _(none)_ | GitHub webhook HMAC secret |
| `CIFN_QUEUE_ADAPTER` | `memory` | Queue adapter: `memory` or `real` |
| `CIFN_ARTIFACTS_ADAPTER` | `memory` | Artifacts adapter: `memory` or `real` |
| `CIFN_SECRETS_ADAPTER` | `memory` | Secrets adapter: `memory` or `real` |
| `CIFN_LOGS_ADAPTER` | `memory` | Logs adapter: `memory` or `real` |

### Production Adapter URLs (required when adapter = `real`)

| Variable | Required when | Description |
|---|---|---|
| `FLOWFN_BASE_URL` | `CIFN_QUEUE_ADAPTER=real` | flowfn service URL |
| `FLOWFN_API_KEY` | `CIFN_QUEUE_ADAPTER=real` | flowfn API key |
| `FILEFN_BASE_URL` | `CIFN_ARTIFACTS_ADAPTER=real` | filefn service URL |
| `FILEFN_API_KEY` | `CIFN_ARTIFACTS_ADAPTER=real` | filefn API key (optional) |
| `SECFN_BASE_URL` | `CIFN_SECRETS_ADAPTER=real` | secfn service URL |
| `SECFN_API_KEY` | `CIFN_SECRETS_ADAPTER=real` | secfn API key (optional) |
| `SECFN_VAULT_PATH` | `CIFN_SECRETS_ADAPTER=real` | secfn vault path (optional) |
| `LOGFN_BASE_URL` | `CIFN_LOGS_ADAPTER=real` | logfn service URL |
| `LOGFN_API_KEY` | `CIFN_LOGS_ADAPTER=real` | logfn API key (optional) |
| `LOGFN_SINK` | `CIFN_LOGS_ADAPTER=real` | logfn sink name (optional) |

### Runner (Required)

| Variable | Description | Source |
|---|---|---|
| `CIFN_CONTROL_PLANE_URL` | Base URL of the control plane | Infrastructure config |
| `CIFN_RUNNER_ID` | Runner ID (from registration response) | `POST /api/v1/runners/register` |
| `CIFN_RUNNER_SECRET` | Runner-scoped secret (from registration response) | `POST /api/v1/runners/register` |

### Runner (Optional)

| Variable | Default | Description |
|---|---|---|
| `CIFN_RUNNER_LABELS` | `default` | Comma-separated runner labels |
| `CIFN_POLL_INTERVAL_MS` | `5000` | Heartbeat/poll interval in ms |

## Runner Registration

Before starting a runner, register it with the control plane:

```bash
curl -X POST http://localhost:3100/api/v1/runners/register \
  -H "Content-Type: application/json" \
  -d '{"token": "<CIFN_RUNNER_REGISTRATION_TOKEN>", "labels": ["default"]}'
# Returns: {"ok":true,"data":{"runnerId":"runner_...","runnerSecret":"rs_..."}}
```

Use the returned `runnerId` and `runnerSecret` as `CIFN_RUNNER_ID` and `CIFN_RUNNER_SECRET`.

## Missing Environment Variable Behavior

Both the control plane and runner **fail fast** on startup when required environment variables are missing:

- **Control plane**: exits with code 1 and prints `Fatal: missing required environment variable: <NAME>`.
- **Runner**: exits with code 1 and prints `Missing required environment variable: <NAME>`.
- **Adapter validation**: if an adapter is set to `real` but its required URLs are missing, the control plane exits with code 1 and prints a specific error (e.g., `Fatal: FLOWFN_BASE_URL is required when CIFN_QUEUE_ADAPTER=real`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Control plane exits immediately | Missing required env var | Check error output; set the variable |
| Runner exits immediately | Missing `CIFN_CONTROL_PLANE_URL`, `CIFN_RUNNER_ID`, or `CIFN_RUNNER_SECRET` | Set the missing variable |
| `UNAUTHORIZED` on API calls | Invalid or missing API key | Verify `CIFN_API_KEYS` contains the key you are using |
| `RUNNER_TOKEN_INVALID` | Registration token mismatch | Verify `CIFN_RUNNER_REGISTRATION_TOKEN` matches secfn |
| Runner can't connect | Control plane not reachable | Verify `CIFN_CONTROL_PLANE_URL`; check network/DNS |
| Adapter errors on startup | `real` adapter missing URL | Set the required `*_BASE_URL` env var |
| Webhook 500 | Webhook secret not configured | Set `CIFN_WEBHOOK_SECRET` or store in secfn as `cifn.webhook.github` |

## Smoke Test Procedure (TV-DEPLOY-001)

1. Start services with memory adapters (see Quick Start above).
2. Verify `/health` returns `{"ok":true}`.
3. Create a run via `POST /api/v1/runs` with a valid API key and inline pipeline spec.
4. Verify the response contains `runId` and `status: "queued"`.
5. List runs via `GET /api/v1/runs` and confirm the created run appears.

## hostfn Smoke Test (TV-DEPLOY-002)

1. Store required secrets in secfn (see hostfn Deployment section).
2. Run `hostfn deploy staging --ci` using the example config.
3. Verify `/health` responds on the deployed URL.
4. Create a run and verify it appears in the run list.

## Architecture

```
┌──────────────────────┐         ┌──────────────────────┐
│   Control Plane      │         │   Runner             │
│                      │  HTTP   │                      │
│   Hono HTTP API      │◄────────│   Poll loop          │
│   Pipeline parser    │         │   Job executor       │
│   Run store          │         │   Step handlers      │
│   Queue dispatch     │         │   Log redaction      │
│                      │         │                      │
│   Adapters:          │         │   Env:               │
│   - flowfn (queue)   │         │   - CIFN_RUNNER_ID   │
│   - filefn (arts)    │         │   - CIFN_RUNNER_SECRET│
│   - secfn (secrets)  │         │   - CIFN_CONTROL_URL │
│   - logfn (logs)     │         │                      │
└──────────────────────┘         └──────────────────────┘
         │                                │
         ▼                                ▼
   secfn (secrets)                  workspace (tmp)
   flowfn (queue)
   filefn (artifacts)
   logfn (observability)
```
