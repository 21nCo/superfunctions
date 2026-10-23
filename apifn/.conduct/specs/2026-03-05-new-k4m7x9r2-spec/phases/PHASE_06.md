# Phase 06: OpenCollection Read/Write

## Phase Goal
Implement reading and writing OpenCollection YAML collections from/to the filesystem.

## In Scope
- `readCollection(dir)` — read opencollection.yml + all request/folder/environment files
- `writeCollection(collection)` — write collection to disk
- `validateCollection(collection)` — validate against OpenCollection schema
- Folder hierarchy, seq ordering, nested folders

## Out of Scope
- Collection generation from OpenAPI (next phase)
- Collection runner (later phase)

## Deliverables
- `apifn/collections/src/reader.ts`
- `apifn/collections/src/writer.ts`
- `apifn/collections/src/validator.ts`
- `apifn/collections/__tests__/reader.test.ts`
- `apifn/collections/__tests__/writer.test.ts`
- `apifn/collections/__tests__/fixtures/` — sample OpenCollection directories

## Requirements Covered
- COLL-001, COLL-002, COLL-003, COLL-006, COLL-007

## Implementation Tasks
1. [ ] Add `yaml` and `glob` dependencies to @apifn/collections
2. [ ] Implement `readCollection(dir)`: find `opencollection.yml`, recursively read `.yml` files, parse into Collection structure
3. [ ] Implement folder discovery: detect `folder.yml`, build hierarchy
4. [ ] Implement environment reading: `environments/*.yml` → Environment objects
5. [ ] Implement `writeCollection(collection)`: create directory structure, write YAML files
6. [ ] Implement `validateCollection()`: validate against OpenCollection JSON Schema
7. [ ] Create test fixtures: a minimal collection directory, a Bruno-compatible collection
8. [ ] Write round-trip test: `readCollection(writeCollection(col))` → structurally equal
9. [ ] Write Bruno interop test: read a Bruno 3.0 YAML collection fixture
10. [ ] Export from collections index

## Verification Steps
1. `npm run test` → all collection read/write tests pass
2. TV-COLL-001: Read test fixture → correct Collection object
3. Round-trip: write then read → equal
4. TV-COLL-006: Bruno fixture readable

## Stop Condition
Collection read/write round-trips correctly. Bruno fixtures parse without errors.
