# SearchFn Specification (Draft)

Last updated: 2026-01-14  
Status: Draft (not implemented)  
Owner: Platform (Superfunctions)

## Goal
Evolve `searchfn` from a browser-first IndexedDB/BM25 library into a full search platform: self-hosted service + SDKs (TS + Python) with hybrid search (BM25 + optional embeddings), connectors, admin UI, and multi-tenant auth/observability, while keeping the existing browser/local mode.

## Scope (v1)
- Service/API layer:
  - HTTP (and/or tRPC) API for ingest, search, schema, collections, snapshots.
  - Adapters via `@superfunctions/http` (Express/Fastify/Hono/Next/Workers).
  - Multi-tenant auth via `authfn`; rate limiting; per-tenant API keys.
- Storage backends:
  - Browser: IndexedDB (existing) for local mode.
  - Server: Postgres primary; pgvector for embeddings (optional); SQLite for dev.
  - Snapshots in S3-compatible blob storage.
- Hybrid search:
  - BM25 first-pass (existing engine), optional embedding index + rerank.
  - Pluggable vector store (pgvector first); minimal reranker (small transformer).
- Connectors & ingestion:
  - Ingestion workers; connectors via `plugfn` (GitHub/Notion/Slack/GDrive/S3) and simple crawler (sitemap/HTML fetch).
  - Webhook/stream-based incremental updates; dedupe and schema/field mapping.
- SDKs:
  - TypeScript: extend current package to call service; preserve `mode: local|remote|hybrid`.
  - Python: mirror HTTP API; support local snapshots where applicable.
- Admin/ops:
  - Minimal dashboard: collections, schemas, ingest status, errors, search analytics (slow/fail), driven by `watchfn` metrics.
  - CLI for ingest, snapshots, schema deploy, backfill.

## Non-Goals (v1)
- Heavy ML relevance tuning/learning-to-rank (basic rerank only).
- Full-blown crawler suite (keep it simple).
- Enterprise SSO (can be added later via `authfn`).

## Architecture
- Core engine: reuse existing BM25/indexing pipeline; expose server-side storage abstraction; keep browser IndexedDB path intact.
- API service:
  - Endpoints: create/update collections & schemas; ingest docs (stream/batch); search; autocomplete; snapshots export/import; stats.
  - Adapters via `@superfunctions/http`; deployable to Node/edge.
- Storage:
  - Postgres tables for terms/postings/vectors/docs (or hybrid with pgvector).
  - Snapshot blobs to S3-compatible storage.
  - Caching: LRU for hot postings/vectors (reuse existing cache patterns).
- Hybrid search:
  - Pipeline: BM25 candidates → optional vector rerank → optional small model rerank.
  - Config per collection to enable embeddings; embeddings via pluggable provider (local model or external).
- Connectors:
  - Workers that pull from providers (GitHub/Notion/Slack/GDrive/S3) using plugfn; normalize into ingest batches.
  - Webhook handlers for incremental updates where available.

## Security & Tenancy
- `authfn` for tenant auth + API keys.
- Per-tenant rate limits; quotas; max index size per collection (configurable).
- Field-level filters for ACL (doc-level filtering hook).

## Observability
- `watchfn` for request metrics, ingest latency, error rates, slow queries; `logfn` for structured logs.
- Health endpoints; ingest/search dashboards (basic) powered by watchfn metrics.

## SDKs
- TypeScript:
  - `SearchFn` retains local mode; add remote client for service API; hybrid mode can route local-first then remote.
  - Helpers for schema definition, ingest batching, snapshot import/export.
- Python:
  - Client for API; snapshot helpers; optional local-mode subset (if feasible).

## Testing Strategy
- Unit: scoring, indexing, pipeline, connector transforms.
- Integration: API contract (ingest/search), Postgres storage, pgvector path, snapshot round-trip, rate limit/auth.
- Connectors: mocked provider responses (plugfn); webhook flows.
- Load/relevance: ingest/load tests; regression suite for BM25 and hybrid ranking.

## Roadmap (phased)
- v0: Service skeleton + Postgres storage; HTTP API + TS client; keep browser local mode intact.
- v1: Connectors (GitHub/Notion/Slack), S3 snapshots, pgvector embeddings + rerank; Python client.
- v1.1: Admin dashboard (minimal), crawler (sitemap/HTML), autocomplete endpoint.
- v1.2: Rate limits/quotas, ACL hooks, more adapters (Workers/edge), more connectors (GDrive/S3).
