# PHASE_13 Completion Report: Observability + limits hardening

**Spec**: 2026-02-07-new-zr4cvxyp-spec  
**Phase**: PHASE_13  
**Date**: 2026-02-11  

## Summary

Enforced limits consistently and implemented structured logging with redaction. Limit constants in server (MAX_DOCS_PER_RELEASE, MAX_RICHTEXT_BLOCKS); release storage uses limits; studio precheck for richtext blocks before save. Logger never logs body, token, password, or other sensitive keys.

## Requirements

- **OBS-001**: Structured logging; redaction guarantees (no raw doc bodies, no asset bytes, no auth secrets).
- **LIMIT-001**: Upload size (client pre-check in PHASE_08), richtext max blocks (client precheck), release size (server at add-time).

## Deliverables

### CmsFn Server

- **server/src/limits/limits.ts** — MAX_DOCS_PER_RELEASE = 500, MAX_RICHTEXT_BLOCKS = 5000.
- **server/src/storage/releases.ts** — Imports MAX_DOCS_PER_RELEASE from limits; add rejects when docIds.length >= limit with VALIDATION_FAILED.
- **server/src/logging/logger.ts** — createLogger(config): logMutation(input), logAuth(input); safeMeta() omits body, token, password, secret, authorization; sink receives only safe metadata.

### CmsFn Studio

- **studio/src/limits/precheck.ts** — MAX_RICHTEXT_BLOCKS = 5000; countRichtextBlocks(value); checkRichtextLimits(formState, docType, maxBlocks) returns ok or { ok: false, path }.
- **studio/src/panes/editor/DocumentEditorPane.tsx** — Before save, runs checkRichtextLimits(formState, docType); on failure sets validationError(path) and does not call patchDoc.

### Tests

- **server/src/__tests__/logging.test.ts** — TV-OBS-001 (logMutation with body: log output does not contain doc body), TV-OBS-002 (logAuth with token/password: output does not contain them).
- **server/src/__tests__/releases.test.ts** — TV-LIMIT-RELEASE-001 (add 500 docs then 501st returns VALIDATION_FAILED).
- **studio/src/__tests__/limits.test.tsx** — countRichtextBlocks, checkRichtextLimits under/over limit; TV-LIMIT-RICHTEXT-001 (editor with richtext over max blocks: save does not call patchDoc).
- TV-LIMIT-UPLOAD-001: already covered in studio media.test.tsx (PHASE_08).

## Test status

- TV-OBS-001: PASS  
- TV-OBS-002: PASS  
- TV-LIMIT-UPLOAD-001: PASS (existing in media.test)  
- TV-LIMIT-RICHTEXT-001: PASS  
- TV-LIMIT-RELEASE-001: PASS  

## Verification

- cmsfn/server: npm run build && npm run test — 31 tests (all pass).
- cmsfn/studio: npm run build && npm run test — 38 tests (all pass).

## Notes

- Logger is created but not yet wired into server request handlers (login, role changes, release publish, preview token); phase deliverable was the logger module and redaction tests. Wiring can be done in a follow-up.
- Richtext limit enforced client-side only (precheck before patch); server could add validation in a future phase if needed.

## Ready for next phase?

Yes — limits and observability (logger + redaction) are implemented and tested.
