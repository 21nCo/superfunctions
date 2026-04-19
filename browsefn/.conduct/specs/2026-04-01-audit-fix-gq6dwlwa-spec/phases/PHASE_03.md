# Phase goal

Make the TypeScript image search and download surface fully functional and safe.

## In scope / Out of scope

- **In scope**:
  - normalized image search
  - real image downloads
  - batch downloads
  - overwrite behavior
  - metadata inclusion and transform validation
- **Out of scope**:
  - Python image parity
  - geo completion

## Deliverables

- `browsefn/typescript/src/images/browser.ts`
- `browsefn/typescript/src/images/providers/unsplash.ts`
- `browsefn/typescript/src/images/providers/pixabay.ts`
- `browsefn/typescript/src/images/providers/pexels.ts`
- `browsefn/typescript/src/core/types.ts`
- `browsefn/typescript/tests/image-browser.test.ts`
- `browsefn/typescript/tests/image-providers.test.ts`

## Requirements covered

- IMG-001
- IMG-002
- SEC-001

## Implementation tasks

1. Normalize provider result mapping for image search.
2. Ensure `download()` writes the file it reports and respects overwrite protection.
3. Implement `downloadBatch()` ordering, progress, and per-item error handling.
4. Validate crop, resize, format, watermark, and metadata options before file output.
5. Add tests covering overwrite safety and real file writes.

## Verification steps

1. Run `npm --prefix browsefn/typescript run test -- --run image-browser image-providers`.
Expected: image tests pass.
2. Run `npm --prefix browsefn/typescript run typecheck`.
Expected: typecheck exits `0`.

## Stop condition

Report the file-write path used by downloads, the overwrite-failure behavior, and the batch progress contract.
