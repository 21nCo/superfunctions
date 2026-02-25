# Phase 01: Core TypeScript Loading

**Goal**: Enable CLI to load and process TypeScript schema files via explicit `--schema` path

**Duration Estimate**: 2-3 hours

---

## In Scope

### Features
- File extension validation (accept `.datafn.ts`, reject `.ts`)
- Dynamic TypeScript module import
- Schema extraction from default export
- Schema extraction from named `schema` export (fallback)
- Integration with existing validation and type generation pipeline
- Basic error handling for missing exports and import failures

### Technical Components
- New function: `validateAndResolveExplicitPath(path: string): string`
- New function: `loadSchema(path: string): Promise<unknown>`
- New function: `loadTypeScriptSchema(path: string): Promise<unknown>`
- Modified function: `generateTypesCommand()` (make async, use new loaders)
- Updated imports: add `extname` from `node:path`

---

## Out of Scope

- Auto-discovery mechanism (Phase 02)
- Enhanced error messages with actionable suggestions (Phase 03)
- Help text updates (Phase 03)
- Comprehensive test coverage (Phase 03)
- Cross-runtime testing (Phase 03)

---

## Deliverables

### Code Changes

**File**: `datafn/cli/src/cli.ts`

1. **Add imports**:
```typescript
import { extname } from 'node:path';
```

2. **Add `validateAndResolveExplicitPath()` function**:
```typescript
function validateAndResolveExplicitPath(path: string): string {
  const ext = extname(path);

  if (ext === '.json') {
    return resolve(path);
  }

  if (ext === '.ts') {
    if (!path.endsWith('.datafn.ts')) {
      throw new Error(
        `Invalid schema file extension\n` +
        `  Expected: *.datafn.ts or *.json\n` +
        `  Got: ${path}\n\n` +
        `  TypeScript schema files must use .datafn.ts extension for security.`
      );
    }
    return resolve(path);
  }

  throw new Error(
    `Unsupported schema file extension: ${ext}\n` +
    `  Supported: .json, .datafn.ts`
  );
}
```

3. **Add `loadTypeScriptSchema()` function**:
```typescript
async function loadTypeScriptSchema(path: string): Promise<unknown> {
  const absolutePath = resolve(path);

  try {
    // Dynamic import works natively in Bun, requires tsx in Node.js
    const module = await import(absolutePath);

    // Prefer default export, fallback to named 'schema' export
    const schema = module.default ?? module.schema;

    if (!schema) {
      throw new Error(
        `No schema export found in ${path}\n` +
        `  Expected: default export or named "schema" export`
      );
    }

    return schema;
  } catch (err: any) {
    // Re-throw with additional context if not already our error
    if (err.message.includes('No schema export found')) {
      throw err;
    }
    throw new Error(`Failed to load TypeScript schema from ${path}: ${err.message}`);
  }
}
```

4. **Add `loadSchema()` function**:
```typescript
async function loadSchema(path: string): Promise<unknown> {
  const ext = extname(path);

  if (ext === '.json') {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  if (ext === '.ts') {
    return await loadTypeScriptSchema(path);
  }

  throw new Error(`Unsupported file extension: ${ext}`);
}
```

5. **Modify `generateTypesCommand()` to be async**:
```typescript
async function generateTypesCommand() {
  try {
    if (!values.schema) {
      console.error('Error: --schema <path> is required for generate-types');
      process.exit(1);
    }

    const schemaPath = validateAndResolveExplicitPath(values.schema);
    const schema = await loadSchema(schemaPath);
    const output = generateTypes(schema);
    const outputPath = resolve(values.output || './datafn-types.ts');

    writeFileSync(outputPath, output);
    console.log(`✓ Types written to: ${outputPath}`);
  } catch (err: any) {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  }
}
```

6. **Update command dispatcher to handle async**:
```typescript
if (command === 'generate-migration') {
  generateMigration();
} else if (command === 'generate-types') {
  await generateTypesCommand();  // Add await
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
```

7. **Make top-level code async-safe** (wrap in IIFE if needed):
```typescript
#!/usr/bin/env node
(async () => {
  // ... existing parseArgs and help/version logic ...

  if (command === 'generate-migration') {
    generateMigration();
  } else if (command === 'generate-types') {
    await generateTypesCommand();
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
})();
```

### Package.json Changes

**File**: `datafn/cli/package.json`

Add optional dependency for Node.js TypeScript loading:

```json
{
  "optionalDependencies": {
    "tsx": "^4.7.0"
  }
}
```

**Note**: tsx is optional because Bun has native TypeScript support.

---

## Requirements Covered

- **FR-EXT-001**: File extension validation ✅
- **FR-TS-001**: TypeScript schema loading ✅
- **FR-EXPORT-001**: Schema export extraction ✅
- **FR-PATH-001**: Explicit schema path override ✅ (partial - auto-discovery in Phase 02)
- **FR-VAL-001**: Schema validation ✅ (existing `validateSchema()` called)

---

## Implementation Tasks

### Task 1.1: Add Extension Validation
- [ ] Add `extname` import from `node:path`
- [ ] Implement `validateAndResolveExplicitPath()`
- [ ] Test with `.json`, `.datafn.ts`, `.ts`, and other extensions
- [ ] Verify error messages are clear

### Task 1.2: Add TypeScript Loading
- [ ] Implement `loadTypeScriptSchema()`
- [ ] Handle default export extraction
- [ ] Handle named `schema` export extraction
- [ ] Handle missing export error
- [ ] Test with sample `.datafn.ts` files

### Task 1.3: Integrate with Schema Loading
- [ ] Implement `loadSchema()` dispatcher
- [ ] Route `.json` to existing JSON.parse
- [ ] Route `.ts` to new loadTypeScriptSchema
- [ ] Test both paths work

### Task 1.4: Update generateTypesCommand
- [ ] Convert function to async
- [ ] Use new validation and loading functions
- [ ] Update error handling
- [ ] Test end-to-end with TypeScript file

### Task 1.5: Make CLI Entry Point Async-Safe
- [ ] Wrap top-level code in async IIFE if needed
- [ ] Add await to generateTypesCommand call
- [ ] Verify CLI still works for generate-migration

### Task 1.6: Add Optional Dependency
- [ ] Add tsx to package.json optionalDependencies
- [ ] Test with Node.js (tsx installed)
- [ ] Test with Bun (no tsx needed)
- [ ] Document tsx requirement in error message if missing

---

## Verification Steps

### Manual Testing

1. **Create test TypeScript schema**:
```bash
cat > test-schema.datafn.ts << 'EOF'
export default {
  resources: [
    {
      name: 'test',
      version: 1,
      fields: [{ name: 'id', type: 'string', required: true }],
    },
  ],
  relations: [],
};
EOF
```

2. **Test TypeScript loading**:
```bash
bun run build
bun dist/cli.js generate-types --schema ./test-schema.datafn.ts --output ./test-output.ts
```

Expected: Types file created successfully

3. **Test extension validation**:
```bash
mv test-schema.datafn.ts test-schema.ts
bun dist/cli.js generate-types --schema ./test-schema.ts
```

Expected: Error about invalid extension

4. **Test JSON backward compatibility**:
```bash
bun dist/cli.js generate-types --schema ./schema.json --output ./json-output.ts
```

Expected: Still works as before

5. **Test named export**:
```bash
cat > named-export.datafn.ts << 'EOF'
export const schema = {
  resources: [],
  relations: [],
};
EOF

bun dist/cli.js generate-types --schema ./named-export.datafn.ts
```

Expected: Schema extracted from named export

### Automated Testing

Create minimal unit test:

```typescript
// __tests__/ts-loading.test.ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

describe('Phase 01: TypeScript Loading', () => {
  it('loads schema from .datafn.ts with default export', () => {
    writeFileSync('test.datafn.ts', `
      export default {
        resources: [{ name: 'test', version: 1, fields: [] }],
        relations: [],
      };
    `);

    const result = execSync('bun dist/cli.js generate-types --schema ./test.datafn.ts');
    expect(result.toString()).toContain('Types written to');

    unlinkSync('test.datafn.ts');
    unlinkSync('datafn-types.ts');
  });

  it('rejects .ts files without .datafn extension', () => {
    writeFileSync('test.ts', 'export default {}');

    expect(() => {
      execSync('bun dist/cli.js generate-types --schema ./test.ts');
    }).toThrow();

    unlinkSync('test.ts');
  });
});
```

---

## Stop Condition

✅ Phase 01 is complete when:

1. Command `datafn generate-types --schema ./test.datafn.ts` successfully generates types
2. Extension validation rejects `.ts` files (without `.datafn.`)
3. Both default and named exports are extracted correctly
4. JSON schema loading still works (backward compatibility)
5. Basic error handling covers missing exports and import failures
6. Code builds successfully
7. Manual testing passes all scenarios above

---

## Risks & Issues

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| tsx not available in Node.js | Medium | High | Clear error message, document requirement |
| Dynamic import syntax errors | Low | Medium | Wrap in try-catch, provide helpful error |
| Async/await breaks existing code | Low | High | Thorough testing of both commands |
| File path resolution issues | Low | Medium | Use absolute paths via resolve() |

---

## Rollback Plan

If Phase 01 cannot be completed:

1. Revert all changes to `cli.ts`
2. Remove tsx from package.json
3. Document blockers for future attempt
4. Keep existing JSON-only functionality
