# PHASE_08: Assets subsystem

## Phase goal

Implement asset upload and retrieval with metadata, limits enforcement, and canonical asset references.

## In scope

- HTTP endpoints:
  - `POST /contentfn/assets/upload`
  - `POST /contentfn/assets/get`
- Asset metadata persistence:
  - filename, contentType, size, url, createdAt
  - width/height for images when determinable
- Payload size enforcement for uploads

## Out of scope

- Image transformations/CDN variants (Undefined unless added by deployment)
- Complex media library UI (belongs to `cmsfn`)

## Deliverables

- `contentfn/server/src/http/endpoints/assets.ts`
- `contentfn/server/src/storage/assets.ts`
- `contentfn/server/src/storage/storageBackend.ts` (interface wrapper; integrates with configured storage)
- `contentfn/server/src/assets/metadata.ts` (image probing when possible)
- Tests implementing:
  - TV-ASSET-UPLOAD-001
  - TV-ASSET-UPLOAD-002
  - TV-ASSET-GET-001
  - TV-ASSET-GET-002

## Requirements covered

- ASSET-001
- LIMIT-001 (payload enforcement; partial)

## Implementation tasks

1. Define storage backend interface for writing bytes and returning a URL.
2. Implement upload:
   - validate base64
   - enforce `maxPayloadBytes`
   - write bytes to backend
   - compute metadata (size, and width/height for images)
   - persist asset record and return `{ assetId, url }`
3. Implement get:
   - return metadata + url
   - missing returns `ASSET_NOT_FOUND`
4. Ensure logging excludes raw bytes (OBS-001 integration in PHASE_12).

## Verification steps

- Run asset tests and verify metadata fields.
- Confirm oversized payload returns `PAYLOAD_TOO_LARGE`.

## Stop condition

- Assets endpoints pass referenced TVs and do not log raw bytes.

