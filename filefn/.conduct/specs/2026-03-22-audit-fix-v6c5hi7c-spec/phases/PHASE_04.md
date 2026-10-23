# PHASE_04

- Phase goal: Upgrade `@filefn/client` for stable file IDs, OPFS-backed immediate local preview, and HEIC preprocessing.
- In scope / Out of scope
  - In scope: `generateFileId()`, OPFS preview metadata, local pending render support, preprocessing pipeline, HEIC converter.
  - Out of scope: viewer package, Nucleus integration, migration scripts.
- Deliverables
  - `filefn/client/src/index.ts`
  - `filefn/client/src/types.ts`
  - `filefn/client/src/client.ts`
  - `filefn/client/src/upload-manager.ts`
  - `filefn/client/src/offline/opfs-store.ts`
  - `filefn/client/src/offline/sync.ts`
  - new `filefn/client/src/preprocessing/types.ts`
  - new `filefn/client/src/preprocessing/heic.ts`
  - client tests under `filefn/client/src/__tests__/`
- Requirements covered
  - `CLIENT-001`
  - `CLIENT-002`
  - `CLIENT-003`
  - `UPLOAD-001`
  - `BUILD-001`
- Implementation tasks
  1. Add stable file ID generation and automatic offline file ID assignment.
  2. Persist file ID plus local preview metadata in OPFS pending-upload entries.
  3. Add a preprocessing interface to client upload flows.
  4. Implement browser HEIC conversion as a built-in preprocessor.
  5. Expand client tests for offline preview and HEIC failure cases.
- Verification steps
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/client test -- --run`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/client run typecheck`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/client run build`
  - Expected outcome: client tests prove stable file IDs, immediate local preview, and HEIC preprocessing behavior.
- Stop condition
  - Report the persisted OPFS pending-upload shape and the final public client API signatures added or changed.
