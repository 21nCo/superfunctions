# Phase 02: Auto-Discovery Mechanism

**Goal**: Enable zero-config CLI usage by auto-discovering schema files in predictable locations

**Duration Estimate**: 1-2 hours

**Prerequisites**: Phase 01 complete (TypeScript loading functional)

---

## In Scope

### Features
- Auto-discovery search algorithm (4 locations)
- Path resolution logic
- Discovery result logging ("✓ Found schema: ...")
- JSON fallback compatibility
- TypeScript preference over JSON
- Error message when no schema found
- Integration with Phase 01 validation

### Technical Components
- New function: `autoDiscoverSchema(): string`
- Modified function: `generateTypesCommand()` (remove required --schema check)
- New function: `resolveSchemaPath(): string`

---

## Out of Scope

- Enhanced error messages with suggestions (Phase 03)
- Help text updates (Phase 03)
- Comprehensive test vectors (Phase 03)
- Documentation (Phase 03)

---

## Deliverables

### Code Changes

**File**: `datafn/cli/src/cli.ts`

1. **Add `autoDiscoverSchema()` function**:
```typescript
function autoDiscoverSchema(): string {
  const candidates = [
    './schema.datafn.ts',
    './src/schema.datafn.ts',
    './schema.json',
    './src/schema.json',
  ];

  for (const candidate of candidates) {
    const fullPath = resolve(candidate);
    if (existsSync(fullPath)) {
      console.log(`✓ Found schema: ${candidate}`);
      return fullPath;
    }
  }

  throw new Error(
    'No schema file found\n' +
    '  Searched locations:\n' +
    '    - ./schema.datafn.ts\n' +
    '    - ./src/schema.datafn.ts\n' +
    '    - ./schema.json\n' +
    '    - ./src/schema.json\n\n' +
    '  Provide explicit path: --schema <path>'
  );
}
```

2. **Add `resolveSchemaPath()` function**:
```typescript
function resolveSchemaPath(): string {
  if (values.schema) {
    // Explicit path provided - validate and resolve
    return validateAndResolveExplicitPath(values.schema);
  }

  // Auto-discovery
  return autoDiscoverSchema();
}
```

3. **Modify `generateTypesCommand()` to use auto-discovery**:
```typescript
async function generateTypesCommand() {
  try {
    // Remove the early exit check for missing --schema
    // const schemaPath = validateAndResolveExplicitPath(values.schema);
    const schemaPath = resolveSchemaPath(); // Use new resolver

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

---

## Requirements Covered

- **FR-DISC-001**: Auto-discovery search algorithm ✅
- **FR-PATH-001**: Explicit path override (integrated) ✅
- **FR-COMPAT-001**: JSON fallback in auto-discovery ✅

---

## Implementation Tasks

### Task 2.1: Implement Auto-Discovery
- [ ] Implement `autoDiscoverSchema()` function
- [ ] Define search candidates array (4 locations)
- [ ] Implement loop with existsSync check
- [ ] Add discovery logging
- [ ] Handle no-file-found error

### Task 2.2: Integrate Path Resolution
- [ ] Implement `resolveSchemaPath()` dispatcher
- [ ] Route explicit --schema to validation
- [ ] Route no --schema to auto-discovery
- [ ] Test both code paths

### Task 2.3: Update generateTypesCommand
- [ ] Remove --schema required check
- [ ] Replace explicit validation with resolveSchemaPath
- [ ] Verify error handling still works
- [ ] Test with and without --schema flag

### Task 2.4: Test Search Priority
- [ ] Create test scenarios with different file combinations
- [ ] Verify search order is respected
- [ ] Verify TypeScript preferred over JSON
- [ ] Verify src/ fallback works

---

## Verification Steps

### Manual Testing

1. **Test auto-discovery: root TypeScript**:
```bash
# Create schema in root
cat > schema.datafn.ts << 'EOF'
export default {
  resources: [{ name: 'root_ts', version: 1, fields: [] }],
  relations: [],
};
EOF

# Run without --schema flag
bun dist/cli.js generate-types

# Expected: "✓ Found schema: ./schema.datafn.ts"
# Expected: Types generated successfully
```

2. **Test auto-discovery: src/ TypeScript**:
```bash
# Remove root schema, create in src/
rm schema.datafn.ts
mkdir -p src
cat > src/schema.datafn.ts << 'EOF'
export default {
  resources: [{ name: 'src_ts', version: 1, fields: [] }],
  relations: [],
};
EOF

bun dist/cli.js generate-types

# Expected: "✓ Found schema: ./src/schema.datafn.ts"
```

3. **Test auto-discovery: JSON fallback**:
```bash
# Remove TS files, create JSON
rm src/schema.datafn.ts
cat > schema.json << 'EOF'
{
  "resources": [{ "name": "json_fallback", "version": 1, "fields": [] }],
  "relations": []
}
EOF

bun dist/cli.js generate-types

# Expected: "✓ Found schema: ./schema.json"
```

4. **Test priority: TypeScript over JSON**:
```bash
# Create both TS and JSON
cat > schema.datafn.ts << 'EOF'
export default {
  resources: [{ name: 'typescript_wins', version: 1, fields: [] }],
  relations: [],
};
EOF

cat > schema.json << 'EOF'
{
  "resources": [{ "name": "json_ignored", "version": 1, "fields": [] }],
  "relations": []
}
EOF

bun dist/cli.js generate-types

# Expected: "✓ Found schema: ./schema.datafn.ts"
# Expected: TypescriptWins interface, NOT JsonIgnored
```

5. **Test no schema found error**:
```bash
# Remove all schema files
rm schema.datafn.ts schema.json
rm -rf src

bun dist/cli.js generate-types

# Expected: Error listing all 4 search locations
```

6. **Test explicit --schema still works**:
```bash
# Create schema in custom location
mkdir -p config
cat > config/my-schema.datafn.ts << 'EOF'
export default { resources: [], relations: [] };
EOF

bun dist/cli.js generate-types --schema ./config/my-schema.datafn.ts

# Expected: No auto-discovery log
# Expected: Types generated from custom location
```

### Automated Testing

Add integration tests:

```typescript
// __tests__/auto-discovery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync } from 'fs';

describe('Phase 02: Auto-Discovery', () => {
  beforeEach(() => {
    // Clean up any existing schema files
    if (existsSync('schema.datafn.ts')) unlinkSync('schema.datafn.ts');
    if (existsSync('schema.json')) unlinkSync('schema.json');
    if (existsSync('src')) rmSync('src', { recursive: true });
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync('datafn-types.ts')) unlinkSync('datafn-types.ts');
  });

  it('discovers schema.datafn.ts in root', () => {
    writeFileSync('schema.datafn.ts', `
      export default {
        resources: [{ name: 'test', version: 1, fields: [] }],
        relations: [],
      };
    `);

    const result = execSync('bun dist/cli.js generate-types').toString();
    expect(result).toContain('Found schema: ./schema.datafn.ts');
    expect(result).toContain('Types written to');
  });

  it('discovers schema.datafn.ts in src/ directory', () => {
    mkdirSync('src', { recursive: true });
    writeFileSync('src/schema.datafn.ts', `
      export default {
        resources: [{ name: 'test', version: 1, fields: [] }],
        relations: [],
      };
    `);

    const result = execSync('bun dist/cli.js generate-types').toString();
    expect(result).toContain('Found schema: ./src/schema.datafn.ts');
  });

  it('falls back to schema.json when no .datafn.ts exists', () => {
    writeFileSync('schema.json', JSON.stringify({
      resources: [{ name: 'test', version: 1, fields: [] }],
      relations: [],
    }));

    const result = execSync('bun dist/cli.js generate-types').toString();
    expect(result).toContain('Found schema: ./schema.json');
  });

  it('prefers TypeScript over JSON when both exist', () => {
    writeFileSync('schema.datafn.ts', `
      export default {
        resources: [{ name: 'ts_file', version: 1, fields: [] }],
        relations: [],
      };
    `);

    writeFileSync('schema.json', JSON.stringify({
      resources: [{ name: 'json_file', version: 1, fields: [] }],
      relations: [],
    }));

    const result = execSync('bun dist/cli.js generate-types').toString();
    expect(result).toContain('Found schema: ./schema.datafn.ts');

    const output = readFileSync('datafn-types.ts', 'utf-8');
    expect(output).toContain('TsFile'); // TS was used
    expect(output).not.toContain('JsonFile'); // JSON was ignored
  });

  it('throws error when no schema files found', () => {
    expect(() => {
      execSync('bun dist/cli.js generate-types 2>&1');
    }).toThrow();

    // Verify error message lists search locations
    try {
      execSync('bun dist/cli.js generate-types 2>&1');
    } catch (err: any) {
      const output = err.stdout.toString();
      expect(output).toContain('No schema file found');
      expect(output).toContain('./schema.datafn.ts');
      expect(output).toContain('./src/schema.datafn.ts');
      expect(output).toContain('./schema.json');
    }
  });
});
```

---

## Stop Condition

✅ Phase 02 is complete when:

1. Command `datafn generate-types` (no flags) auto-discovers `schema.datafn.ts`
2. Search order is correct: root TS → src/ TS → root JSON → src/ JSON
3. TypeScript files are preferred over JSON when both exist
4. JSON fallback works when no TypeScript files present
5. Error message lists all 4 search locations when no files found
6. Discovery logging shows which file was found
7. Explicit `--schema` still works and skips auto-discovery
8. All manual test scenarios pass
9. Integration tests pass

---

## Risks & Issues

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Monorepo conflicts (wrong file found) | Medium | Low | Clear documentation of search order |
| src/ directory doesn't exist | Low | Low | existsSync handles gracefully |
| User confusion about which file used | Low | Medium | Clear logging of discovered file |

---

## Rollback Plan

If Phase 02 cannot be completed:

1. Revert auto-discovery changes
2. Restore `--schema` as required flag
3. Keep Phase 01 TypeScript loading (still valuable)
4. Document auto-discovery as future enhancement
