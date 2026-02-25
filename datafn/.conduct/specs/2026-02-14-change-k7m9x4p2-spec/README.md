# Specification: CLI TypeScript Schema Support

**Spec ID**: 2026-02-14-change-k7m9x4p2-spec
**Type**: change
**Status**: Ready for Implementation
**Created**: 2026-02-14T03:52:50Z

---

## Quick Links

- [SPEC.md](./SPEC.md) - Main specification document
- [REQUIREMENTS.md](./REQUIREMENTS.md) - Detailed requirements (14 FR + 4 NFR)
- [TEST_VECTORS.md](./TEST_VECTORS.md) - 14 test vectors (9 positive, 5 negative)
- [PLAN.md](./PLAN.md) - 3-phase implementation plan
- [INTENT_AUDIT.md](./INTENT_AUDIT.md) - Intent coverage verification

### Phase Documents
- [Phase 01: Core TypeScript Loading](./phases/PHASE_01.md) - 2-3 hours
- [Phase 02: Auto-Discovery Mechanism](./phases/PHASE_02.md) - 1-2 hours
- [Phase 03: Polish & Documentation](./phases/PHASE_03.md) - 2-3 hours

---

## Executive Summary

Extend the DataFn CLI `generate-types` command to support TypeScript schema files (`.ts`) using an enforced `.datafn.ts` naming convention that enables:

1. **TypeScript Support**: Load schemas from `.datafn.ts` files with type safety
2. **Auto-Discovery**: Zero-config usage via convention (`schema.datafn.ts`)
3. **Security**: Prevent arbitrary code execution via extension enforcement
4. **Backward Compatibility**: Full JSON workflow preservation

---

## Key Features

### Convention-Based Zero Config
```bash
# Just run - no flags needed!
$ datafn generate-types
✓ Found schema: ./schema.datafn.ts
✓ Types written to: ./datafn-types.ts
```

### Enforced `.datafn.ts` Extension
```typescript
// schema.datafn.ts
import type { DatafnSchema } from '@datafn/core';

export default {
  resources: [...],
  relations: [],
} satisfies DatafnSchema;
```

### Smart Auto-Discovery
Search order:
1. `./schema.datafn.ts`
2. `./src/schema.datafn.ts`
3. `./schema.json` (fallback)
4. `./src/schema.json` (fallback)

---

## Implementation Estimate

**Total Duration**: 5-8 hours

| Phase | Duration | Focus |
|-------|----------|-------|
| Phase 01 | 2-3 hours | TypeScript loading, validation |
| Phase 02 | 1-2 hours | Auto-discovery mechanism |
| Phase 03 | 2-3 hours | Error handling, docs, tests |

---

## Requirements Summary

- **14 Functional Requirements** (all MUST)
- **4 Non-Functional Requirements** (3 MUST, 1 SHOULD)
- **14 Test Vectors** (100% coverage)
- **3 Implementation Phases** (independently deployable)

---

## Success Criteria

✅ All 14 test vectors pass
✅ Zero-config auto-discovery works
✅ Extension validation enforces `.datafn.ts`
✅ JSON workflow unchanged (backward compatible)
✅ Both Bun and Node.js supported
✅ Comprehensive documentation
✅ Security guidelines documented

---

## Files in This Specification

```
2026-02-14-change-k7m9x4p2-spec/
├── README.md               # This file
├── SPEC.md                 # Main specification (technical design)
├── REQUIREMENTS.md         # Detailed requirements (FR + NFR)
├── TEST_VECTORS.md         # 14 concrete test cases
├── PLAN.md                 # Implementation strategy
├── INTENT_AUDIT.md         # Coverage verification
├── logs.csv                # Execution log
└── phases/
    ├── PHASE_01.md         # Core TypeScript loading
    ├── PHASE_02.md         # Auto-discovery
    └── PHASE_03.md         # Polish & documentation
```

---

## Next Steps

1. **Review**: Read SPEC.md for technical design
2. **Understand**: Review REQUIREMENTS.md for acceptance criteria
3. **Plan**: Read PLAN.md for implementation strategy
4. **Implement**: Follow phases in order (01 → 02 → 03)
5. **Verify**: Run all 14 test vectors from TEST_VECTORS.md

---

## Related Work

- **Prerequisite**: Issue `2026-02-13-q8m3k7x5-issue` (CLI generate-types wiring) - ✅ Completed
- **Builds On**: `datafn/cli/src/codegen.ts` (existing `generateTypes()` function)
- **References**: `datafn/examples/todo-app/server/src/schema.ts` (TypeScript schema pattern)

---

## Contact & Questions

For questions about this specification:
- Review INTENT_AUDIT.md for intent coverage verification
- Check TEST_VECTORS.md for concrete examples
- See phases/*.md for detailed implementation tasks

**Agent**: claude-sonnet-4-5-20250929
**Created**: 2026-02-14T03:52:50Z
