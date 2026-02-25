# Implementation Plan

## Overview

This document outlines the phased implementation strategy for adding TypeScript schema support to the DataFn CLI `generate-types` command.

---

## Implementation Strategy

### Approach

**Incremental Enhancement**: Build TypeScript support incrementally while maintaining full backward compatibility with existing JSON workflow.

### Phases

The implementation is divided into 3 phases, each independently verifiable and deployable:

1. **Phase 01**: Core TypeScript Loading (file extension validation, TS import, export extraction)
2. **Phase 02**: Auto-Discovery Mechanism (search algorithm, path resolution, fallback logic)
3. **Phase 03**: Polish & Documentation (error messages, help text, tests, docs)

---

## Phase Breakdown

### Phase 01: Core TypeScript Loading

**Duration**: ~2-3 hours
**Deliverables**: TypeScript schema files can be loaded via explicit `--schema` path

**Scope**:
- File extension validation (`.datafn.ts` required)
- Dynamic TypeScript import (Bun native / tsx for Node.js)
- Schema extraction from `default` or `schema` export
- Integration with existing `generateTypes()` pipeline
- Basic error handling

**Stop Condition**: `datafn generate-types --schema ./test.datafn.ts` successfully generates types

**Detailed Plan**: See `phases/PHASE_01.md`

---

### Phase 02: Auto-Discovery Mechanism

**Duration**: ~1-2 hours
**Deliverables**: CLI auto-discovers schema files when `--schema` not provided

**Scope**:
- Search algorithm (4 locations in priority order)
- Path resolution logic
- JSON fallback compatibility
- Discovery logging (which file was found)
- Error messages for no file found

**Stop Condition**: `datafn generate-types` (no flags) successfully finds and uses `schema.datafn.ts`

**Detailed Plan**: See `phases/PHASE_02.md`

---

### Phase 03: Polish & Documentation

**Duration**: ~2-3 hours
**Deliverables**: Production-ready feature with comprehensive docs and tests

**Scope**:
- Enhanced error messages for all failure modes
- Updated `--help` text with examples
- Test vectors implementation (all 14 vectors)
- README/docs updates
- Security documentation (.datafn.ts guidelines)

**Stop Condition**: All test vectors pass, docs complete, PR ready for review

**Detailed Plan**: See `phases/PHASE_03.md`

---

## Dependencies & Prerequisites

### External Dependencies

**Required**:
- `tsx` package (for Node.js TypeScript loading) - to be added to package.json as optional dependency

**Runtime**:
- Bun (native TS support) OR Node.js + tsx

### Internal Dependencies

**No changes required** to:
- `@datafn/core` - schema validation logic unchanged
- `datafn/cli/src/codegen.ts` - `generateTypes()` unchanged
- Test infrastructure - existing vitest setup sufficient

---

## Risk Mitigation

### High-Priority Risks

| Risk | Mitigation Phase | Strategy |
|------|------------------|----------|
| Arbitrary code execution in .ts files | Phase 01 | Enforce `.datafn.ts` extension, document best practices |
| tsx dependency bloat | Phase 01 | Make optional, use dynamic import with helpful error |
| Auto-discovery conflicts (monorepos) | Phase 02 | Clear search order, explicit `--schema` override |
| Breaking existing JSON workflow | All phases | Maintain separate code paths, run existing tests |

---

## Testing Strategy

### Phase 01 Testing
- Unit tests for extension validation
- Unit tests for TypeScript loading
- Unit tests for export extraction
- Integration test: end-to-end with explicit path

### Phase 02 Testing
- Unit tests for search algorithm
- Unit tests for each discovery location
- Integration test: auto-discovery scenarios
- Regression test: JSON fallback

### Phase 03 Testing
- All 14 test vectors from TEST_VECTORS.md
- Error path coverage (negative tests)
- Help text verification
- Cross-runtime testing (Bun + Node.js)

---

## Rollout Plan

### Development

1. Create feature branch: `feat/cli-ts-schema-support`
2. Implement Phase 01, commit
3. Implement Phase 02, commit
4. Implement Phase 03, commit
5. Final integration testing

### Review

- Code review focusing on:
  - Security (extension enforcement)
  - Backward compatibility (JSON tests pass)
  - Error handling (clear messages)
  - Documentation (examples, help text)

### Deployment

- Merge to `next` branch
- Publish as minor version bump (new feature, backward compatible)
- Update main docs with `.datafn.ts` examples

---

## Success Metrics

Implementation is considered complete when:

- ✅ All 14 test vectors pass
- ✅ All existing tests continue to pass
- ✅ Both Bun and Node.js runtimes supported
- ✅ Help text includes TypeScript examples
- ✅ Documentation updated
- ✅ Zero breaking changes to JSON workflow
- ✅ Code review approved
- ✅ PR merged to next branch

---

## Timeline Estimate

| Phase | Duration | Cumulative |
|-------|----------|------------|
| Phase 01: Core TS Loading | 2-3 hours | 2-3 hours |
| Phase 02: Auto-Discovery | 1-2 hours | 3-5 hours |
| Phase 03: Polish & Docs | 2-3 hours | 5-8 hours |
| **Total** | **5-8 hours** | |

**Note**: Timeline assumes single developer, includes testing and documentation.

---

## Open Questions & Decisions

All design decisions have been finalized:

✅ **File extension**: `.datafn.ts` (enforced, no arbitrary `.ts`)
✅ **Export format**: Default export preferred, named `schema` as fallback
✅ **Search order**: root `.datafn.ts` > `src/.datafn.ts` > root `.json` > `src/.json`
✅ **TS loader**: Bun native or tsx for Node.js
✅ **Dependency strategy**: Optional dependency with clear error if missing

No open questions remain.
