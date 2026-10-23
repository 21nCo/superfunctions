# Phase goal

Implement the Data & Storage category with a clear base-package-versus-adapter story and full provider guidance.

## In scope / Out of scope

- **In scope**:
  - Data & Storage overview
  - `db`
  - `storage`
  - `storage-s3`
  - `storage-r2`
  - `storage-minio`
  - `storage-gcs`
  - `storage-azure`
  - `storage-local`
  - `files`
- **Out of scope**:
  - Python pages
  - tooling pages

## Deliverables

- `docs/content/docs/data-storage/meta.json`
- `docs/content/docs/data-storage/index.mdx`
- `docs/content/docs/data-storage/db.mdx`
- `docs/content/docs/data-storage/storage.mdx`
- `docs/content/docs/data-storage/storage-s3.mdx`
- `docs/content/docs/data-storage/storage-r2.mdx`
- `docs/content/docs/data-storage/storage-minio.mdx`
- `docs/content/docs/data-storage/storage-gcs.mdx`
- `docs/content/docs/data-storage/storage-azure.mdx`
- `docs/content/docs/data-storage/storage-local.mdx`
- `docs/content/docs/data-storage/files.mdx`

## Requirements covered

- DOCS-002
- DOCS-004
- DOCS-005
- DOCS-006
- DOCS-007

## Implementation tasks

1. Create a category overview that distinguishes persistence contracts from storage-provider adapters.
2. Add a provider chooser for S3, R2, MinIO, GCS, Azure, and local storage.
3. Rewrite `db`, `storage`, and `files` pages with external-world use cases and code examples.
4. Rewrite each provider adapter page with clear “when to choose this” guidance.

## Verification steps

1. Run `npm -w docs run check:content`.
Expected: data/storage pages satisfy required sections, prose minimums, and chooser requirements.
2. Run `npm -w docs run check:snippets`.
Expected: examples use valid package imports and provider setup examples remain public-safe.

## Stop condition

Report that readers can now distinguish `db`, `storage`, `files`, and storage providers without repo-internal assumptions.
