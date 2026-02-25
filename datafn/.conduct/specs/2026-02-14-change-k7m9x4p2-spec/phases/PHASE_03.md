# Phase 03: Polish & Documentation

**Goal**: Finalize implementation with comprehensive error handling, documentation, and test coverage

**Duration Estimate**: 2-3 hours

**Prerequisites**: Phase 01 and Phase 02 complete (TypeScript loading + auto-discovery functional)

---

## In Scope

### Features
- Enhanced error messages for all failure modes
- Updated CLI help text with TypeScript examples
- Complete test vector implementation (all 14 vectors)
- README/documentation updates
- Security guidelines for `.datafn.ts` files
- Cross-runtime testing (Bun + Node.js)
- Performance verification

### Documentation Components
- Updated help text in `cli.ts`
- README section on TypeScript schema support
- Security best practices for `.datafn.ts` files
- Migration guide (JSON → TypeScript)
- Troubleshooting section

---

## Out of Scope

- Multi-file schema composition
- Schema file watching/hot reload
- Alternative file extensions (only `.datafn.ts` supported)

---

## Deliverables

### Code Changes

**File**: `datafn/cli/src/cli.ts`

1. **Update `printHelp()` function**:
```typescript
function printHelp() {
  console.log(`
@datafn/cli - DataFn CLI

Usage:
  datafn <command> [options]

Commands:
  generate-migration    Generate database migration from schema changes
  generate-types        Generate TypeScript types from schema

Options:
  --schema <path>      Path to schema file (.json or .datafn.ts)
                       Optional: Auto-discovers schema.datafn.ts if omitted
  --from <path>        Path to source schema file (for generate-migration)
  --to <path>          Path to target schema file (for generate-migration)
  --adapter <name>     ORM adapter: drizzle, prisma, kysely, raw (default: raw, for generate-migration)
  --database <name>    Database: postgres, mysql, sqlite (default: postgres, for generate-migration)
  --output <path>      Output file/directory
                       generate-types: ./datafn-types.ts (default)
                       generate-migration: ./migrations (default)
  -h, --help           Show this help message
  -v, --version        Show version

Examples:
  # Generate TypeScript types (auto-discover schema)
  datafn generate-types

  # Generate types from specific TypeScript schema
  datafn generate-types --schema ./schema.datafn.ts --output ./src/types.ts

  # Generate types from JSON schema
  datafn generate-types --schema ./schema.json

  # Generate initial migration
  datafn generate-migration --schema ./schema.json --adapter drizzle --database postgres

  # Generate migration from schema changes
  datafn generate-migration --from ./schema-v1.json --to ./schema-v2.json --adapter drizzle

TypeScript Schema Files:
  TypeScript schema files must use the .datafn.ts extension (e.g., schema.datafn.ts)
  Auto-discovery searches in this order:
    1. ./schema.datafn.ts
    2. ./src/schema.datafn.ts
    3. ./schema.json
    4. ./src/schema.json
`);
}
```

2. **Enhanced error handling in `loadTypeScriptSchema()`**:
```typescript
async function loadTypeScriptSchema(path: string): Promise<unknown> {
  const absolutePath = resolve(path);

  try {
    const module = await import(absolutePath);
    const schema = module.default ?? module.schema;

    if (!schema) {
      throw new Error(
        `No schema export found in ${path}\n\n` +
        `  Expected export format:\n` +
        `    export default { resources: [...], relations: [...] };\n` +
        `  Or:\n` +
        `    export const schema = { resources: [...], relations: [...] };\n\n` +
        `  See: https://datafn.dev/docs/cli/generate-types`
      );
    }

    return schema;
  } catch (err: any) {
    if (err.message.includes('No schema export found')) {
      throw err;
    }

    // Check if tsx is missing in Node.js
    if (err.code === 'ERR_UNKNOWN_FILE_EXTENSION' || err.message.includes('Cannot find module')) {
      throw new Error(
        `Failed to load TypeScript schema from ${path}\n\n` +
        `  TypeScript loading requires 'tsx' package in Node.js.\n` +
        `  Install: npm install tsx --save-dev\n` +
        `  Or use Bun for native TypeScript support.\n\n` +
        `  Original error: ${err.message}`
      );
    }

    throw new Error(
      `Failed to load TypeScript schema from ${path}\n` +
      `  ${err.message}\n\n` +
      `  Common issues:\n` +
      `    - Syntax errors in the .datafn.ts file\n` +
      `    - Missing dependencies imported in schema\n` +
      `    - Circular imports\n`
    );
  }
}
```

### Documentation

**File**: `datafn/cli/README.md` (create or update)

Add section:

```markdown
## TypeScript Schema Support

### Overview

The DataFn CLI supports TypeScript schema files for a better developer experience with type safety and IDE autocomplete.

### Convention: `.datafn.ts` Extension

TypeScript schema files **must** use the `.datafn.ts` extension:

```typescript
// schema.datafn.ts
import type { DatafnSchema } from '@datafn/core';

export default {
  resources: [
    {
      name: 'task',
      version: 1,
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
        { name: 'done', type: 'boolean', required: false },
      ],
    },
  ],
  relations: [],
} satisfies DatafnSchema;
```

**Why `.datafn.ts`?**
- Security: Prevents accidental execution of arbitrary TypeScript files
- Clarity: Signals that the file contains a DataFn schema
- Convention: Similar to `*.config.ts`, `*.spec.ts`, etc.

### Auto-Discovery

When you run `datafn generate-types` without the `--schema` flag, the CLI automatically searches for schema files in this order:

1. `./schema.datafn.ts` (current directory)
2. `./src/schema.datafn.ts` (source directory)
3. `./schema.json` (JSON fallback)
4. `./src/schema.json` (JSON fallback in src)

The first file found is used.

### Export Formats

Your `.datafn.ts` file must export the schema in one of these ways:

**Default export (recommended):**
```typescript
export default { resources: [...], relations: [...] };
```

**Named export:**
```typescript
export const schema = { resources: [...], relations: [...] };
```

### Security Best Practices

⚠️ **Important**: `.datafn.ts` files are executed during import. Follow these guidelines:

**✅ Do:**
- Define schema as a plain object literal
- Import types from `@datafn/core`
- Use simple object/array compositions

**❌ Don't:**
- Make network requests
- Perform file system operations
- Execute side effects in module scope
- Import runtime dependencies unnecessarily

**Good Example:**
```typescript
import type { DatafnSchema } from '@datafn/core';

export default {
  resources: [/* ... */],
  relations: [],
} satisfies DatafnSchema;
```

**Bad Example:**
```typescript
import axios from 'axios'; // ❌ Runtime dependency

const data = await axios.get('/api/schema'); // ❌ Side effect

export default data.schema;
```

### Migrating from JSON to TypeScript

To convert an existing JSON schema to TypeScript:

1. Rename `schema.json` to `schema.datafn.ts`
2. Add type import: `import type { DatafnSchema } from '@datafn/core';`
3. Add export: `export default` before the schema object
4. Add type annotation: `satisfies DatafnSchema` after the object
5. Remove quotes from unquoted JSON keys if desired

**Before (schema.json):**
```json
{
  "resources": [
    {
      "name": "task",
      "version": 1,
      "fields": [...]
    }
  ],
  "relations": []
}
```

**After (schema.datafn.ts):**
```typescript
import type { DatafnSchema } from '@datafn/core';

export default {
  resources: [
    {
      name: 'task',
      version: 1,
      fields: [...]
    }
  ],
  relations: []
} satisfies DatafnSchema;
```

### Troubleshooting

**Error: "Invalid schema file extension"**
- Cause: Trying to use `.ts` file without `.datafn.` convention
- Solution: Rename to `*.datafn.ts`

**Error: "No schema export found"**
- Cause: File doesn't export schema
- Solution: Add `export default { ... }` or `export const schema = { ... }`

**Error: "Failed to load TypeScript schema" (Node.js)**
- Cause: `tsx` package not installed
- Solution: Run `npm install tsx --save-dev` or use Bun

**Types don't match expectations**
- Cause: Schema validation failed
- Solution: Check console output for validation errors from `validateSchema()`

### Requirements

- **Bun**: Native TypeScript support (no additional deps)
- **Node.js**: Requires `tsx` package (`npm install tsx --save-dev`)
```

---

## Requirements Covered

- **FR-ERR-001**: Enhanced error messages ✅
- **FR-HELP-001**: Updated help text ✅
- **NFR-SEC-001**: Security documentation ✅
- **TC-VEC-001**: All 14 test vectors ✅

---

## Implementation Tasks

### Task 3.1: Update Help Text
- [ ] Modify `printHelp()` with TypeScript examples
- [ ] Document auto-discovery behavior
- [ ] Add note about `.datafn.ts` extension
- [ ] Include search order explanation

### Task 3.2: Enhance Error Messages
- [ ] Improve `loadTypeScriptSchema()` error handling
- [ ] Add suggestions for common errors
- [ ] Check for tsx missing in Node.js
- [ ] Add documentation links in errors

### Task 3.3: Implement Test Vectors
- [ ] Create test file for each of 14 vectors
- [ ] Implement positive test cases (9 vectors)
- [ ] Implement negative test cases (5 vectors)
- [ ] Verify all pass in both Bun and Node.js

### Task 3.4: Write Documentation
- [ ] Create/update CLI README
- [ ] Add TypeScript schema section
- [ ] Document security best practices
- [ ] Add migration guide JSON → TS
- [ ] Add troubleshooting section

### Task 3.5: Cross-Runtime Testing
- [ ] Test all features in Bun
- [ ] Test all features in Node.js with tsx
- [ ] Test error message when tsx missing
- [ ] Document runtime requirements

### Task 3.6: Performance Testing
- [ ] Benchmark TS vs JSON loading
- [ ] Verify <200ms overhead
- [ ] Test with large schema files
- [ ] Document findings

---

## Verification Steps

### Complete Test Vector Suite

Run all 14 test vectors from TEST_VECTORS.md:

```bash
bun test __tests__/ts-schema-support.test.ts
```

Expected: All tests pass

### Cross-Runtime Testing

**Bun:**
```bash
bun dist/cli.js generate-types
bun test
```

**Node.js:**
```bash
node dist/cli.js generate-types
npm test
```

### Manual Verification Checklist

- [ ] `datafn generate-types --help` shows TypeScript examples
- [ ] Auto-discovery finds `schema.datafn.ts`
- [ ] Auto-discovery prefers TS over JSON
- [ ] Extension validation rejects `.ts` files
- [ ] Error messages include helpful suggestions
- [ ] README includes complete TypeScript documentation
- [ ] Security best practices documented
- [ ] Migration guide is clear
- [ ] All existing tests still pass
- [ ] No regressions in JSON workflow

---

## Stop Condition

✅ Phase 03 is complete when:

1. All 14 test vectors pass
2. Help text includes comprehensive TypeScript documentation
3. Error messages are clear and actionable
4. README contains complete TypeScript section
5. Security best practices documented
6. Migration guide available
7. Cross-runtime testing passes (Bun + Node.js)
8. Performance benchmarks acceptable (<200ms overhead)
9. All existing tests continue to pass
10. Code review ready (clean, documented, tested)

---

## Final Deliverables Checklist

### Code
- [ ] Enhanced error handling in all functions
- [ ] Updated help text in `printHelp()`
- [ ] All functions properly documented with comments
- [ ] Type annotations where beneficial

### Tests
- [ ] All 14 test vectors implemented
- [ ] Integration tests for auto-discovery
- [ ] Cross-runtime tests (Bun + Node.js)
- [ ] Regression tests (JSON workflow)
- [ ] Performance benchmarks

### Documentation
- [ ] README TypeScript section
- [ ] Security guidelines
- [ ] Migration guide
- [ ] Troubleshooting section
- [ ] Examples and use cases

### Quality
- [ ] No linting errors
- [ ] No type errors
- [ ] All tests pass
- [ ] Code review approved
- [ ] Changelog updated

---

## Risks & Issues

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Documentation incomplete | Low | Medium | Checklist ensures coverage |
| Test coverage gaps | Low | High | 14 test vectors cover all scenarios |
| Performance issues | Low | Medium | Benchmarks verify acceptable speed |
| Missing edge cases | Low | Medium | Comprehensive test suite |

---

## Post-Phase Tasks

After Phase 03 completion:

1. Create pull request with all changes
2. Request code review
3. Address review feedback
4. Merge to `next` branch
5. Prepare release notes
6. Publish new version
7. Update main documentation site
8. Announce feature in community channels
