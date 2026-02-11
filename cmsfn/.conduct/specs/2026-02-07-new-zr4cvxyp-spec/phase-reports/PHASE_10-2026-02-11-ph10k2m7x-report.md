# PHASE_10 Completion Report: Releases (batch publish + scheduling)

**Spec**: 2026-02-07-new-zr4cvxyp-spec  
**Phase**: PHASE_10  
**Date**: 2026-02-11  

## Summary

Implemented releases as named batches of draft documents with deterministic publish behavior. Server endpoints: create, list, add, publish. Release storage with deterministic ordering (createdAt desc, releaseId asc). Publish orchestration calls ContentFn publish per doc with workflow gating and role checks; returns deterministic summary (published[], failures[]). Studio minimal ReleasesPane: list releases, create release, publish.

## Requirements

- **REL-001**: Create/list/add persist release metadata; publishing returns deterministic summary; respects workflow gating and role permissions (release.manage, doc.publish).
- **WF-001**: Publish gate enforced per doc via canPublish(state, hasDocPublish).
- **ROLE-001**: release.manage for create/list/add/publish; doc.publish per doc type for publish.

## Deliverables

### CmsFn Server

- **server/src/storage/releases.ts** — createRelease, listReleases, getRelease, addDocToRelease; table cmsfn_releases; order list by createdAt desc, releaseId asc; max 500 docs per release on add.
- **server/src/http/releases.ts** — handleReleasesCreate, handleReleasesList, handleReleasesAdd, handleReleasesPublish; body validation; requireReleaseManage (release.manage) for all; publish calls publishRelease.
- **server/src/releases/publishRelease.ts** — Load release, sort docIds, for each: getDraftDoc, authorize doc.publish for doc type, canPublish(state, true), contentfnPublish; collect published[] and failures[]; return { releaseId, published, failures }.
- **server/src/index.ts** — POST /cmsfn/releases/create, list, add, publish when config.db set; pass releasesStorage, contentfnBaseUrl, getRolesForSubject.

### CmsFn Studio

- **studio/src/panes/releases/ReleasesPane.tsx** — Minimal pane: list releases (POST list), create form (name), publish button per release; data-releases-pane, data-releases-list, data-releases-publish-result.

### Tests

- **server/src/__tests__/releases.test.ts** — TV-REL-CREATE-001 (create returns releaseId), TV-REL-ADD-001 (add after create ok=true), TV-REL-PUBLISH-001 (publish returns deterministic summary with published doc IDs), TV-REL-PUBLISH-002 (doc failing workflow gate → result.failures with PERMISSION_DENIED).

## Test status

- TV-REL-CREATE-001: PASS  
- TV-REL-ADD-001: PASS  
- TV-REL-PUBLISH-001: PASS  
- TV-REL-PUBLISH-002: PASS  

## Verification

- cmsfn/server: npm run build && npm run test — 21 tests (all pass).
- cmsfn/studio: npm run build && npm run test — 31 tests (all pass).

## Notes

- Publish result is always ok=true with result { releaseId, published, failures }; partial failure is expressed via failures array (deterministic).
- Release ID is UUID (randomUUID). List order: createdAt desc, releaseId asc. Doc order for publish: sorted docIds.

## Ready for next phase?

Yes — releases create/add/list/publish work end-to-end; publish results are deterministic.
