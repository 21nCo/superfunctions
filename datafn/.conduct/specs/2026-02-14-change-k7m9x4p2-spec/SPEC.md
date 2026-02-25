# CLI TypeScript Schema Support Specification

**Timestamp**: 2026-02-14T03:52:50Z
**Agent**: claude-sonnet-4-5-20250929
**Model**: Claude Sonnet 4.5
**Launcher**: Claude Code (VSCode)
**OS**: macOS (arm64)
**Git Branch**: heads/next
**Repo Path**: /Users/ar/dev/superfunctions/datafn

---

## 1. Overview

### 1.1 Purpose

Extend the DataFn CLI `generate-types` command to support TypeScript schema files (`.ts`) in addition to JSON files (`.json`), using an enforced naming convention (`.datafn.ts`) that enables auto-discovery and convention-based zero-config workflows.

### 1.2 Background

Currently, the CLI command `datafn generate-types` only accepts JSON schema files via `--schema <path>`. However, DataFn example applications and typical user projects define schemas in TypeScript files (e.g., `examples/todo-app/server/src/schema.ts`). This creates friction:

- Users must manually export TypeScript schemas to JSON before running CLI commands
- No auto-discovery mechanism exists for schema files
- Convention-based workflows (like `tsconfig.json`, `package.json`) are not supported

### 1.3 Goals

1. **TypeScript Support**: Enable CLI to load and process schema files written in TypeScript
2. **Enforced Convention**: Require `.datafn.ts` file extension to prevent arbitrary code execution and ensure clarity
3. **Auto-Discovery**: Allow zero-config usage by auto-discovering `schema.datafn.ts` in predictable locations
4. **Backward Compatibility**: Maintain full compatibility with existing JSON schema workflow
5. **Security**: Prevent execution of arbitrary user code beyond schema definition

### 1.4 Non-Goals

- Supporting arbitrary `.ts` files without the `.datafn.ts` convention
- Runtime TypeScript compilation in production environments
- Schema validation beyond what `validateSchema()` already provides
- Multi-file schema composition (future enhancement)

---

## 2. User Experience

### 2.1 Convention-Based (Zero Config)

Users create a file named `schema.datafn.ts` in their project root or `src/` directory:

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
      ],
    },
  ],
  relations: [],
} satisfies DatafnSchema;
```

Then run the CLI with zero arguments:

```bash
$ datafn generate-types
✓ Found schema: ./schema.datafn.ts
✓ Types written to: ./datafn-types.ts
```

### 2.2 Explicit Path

Users can explicitly specify any `.datafn.ts` file:

```bash
$ datafn generate-types --schema ./custom.datafn.ts --output ./types.ts
✓ Types written to: ./types.ts
```

### 2.3 JSON Backward Compatibility

Existing JSON workflow remains unchanged:

```bash
$ datafn generate-types --schema ./schema.json
✓ Types written to: ./datafn-types.ts
```

### 2.4 Error Cases

**Missing schema file:**
```bash
$ datafn generate-types
✗ Error: No schema file found
  Expected: schema.datafn.ts in current directory or src/
  Or provide: --schema <path>
```

**Invalid file extension:**
```bash
$ datafn generate-types --schema ./schema.ts
✗ Error: Invalid schema file extension
  Expected: *.datafn.ts or *.json
  Got: schema.ts

  TypeScript schema files must use .datafn.ts extension for security.
```

**No default export:**
```bash
$ datafn generate-types --schema ./schema.datafn.ts
✗ Error: No schema export found in schema.datafn.ts
  Expected: default export or named 'schema' export
```

---

## 3. Technical Design

### 3.1 File Extension Validation

The CLI MUST validate schema file extensions according to:

| Extension       | Allowed | Handling                              |
|-----------------|---------|---------------------------------------|
| `.json`         | ✅      | Parse with `JSON.parse()`             |
| `.datafn.ts`    | ✅      | Compile and import                    |
| `.ts`           | ❌      | Reject with clear error message       |
| `.js`           | ❌      | Reject (use `.datafn.ts` instead)     |
| Other           | ❌      | Reject with supported extensions list |

**Rationale**: Enforcing `.datafn.ts` prevents arbitrary code execution and provides clear semantic meaning.

### 3.2 Auto-Discovery Algorithm

When `--schema` is NOT provided, the CLI MUST search for schema files in this order:

1. `./schema.datafn.ts` (current working directory)
2. `./src/schema.datafn.ts` (conventional source directory)
3. `./schema.json` (fallback to JSON in current directory)
4. `./src/schema.json` (fallback to JSON in src directory)

The first file found MUST be used. If no file is found, the CLI MUST exit with a clear error message listing the search paths.

### 3.3 TypeScript Loading Strategy

For `.datafn.ts` files, the CLI MUST:

1. **Detect Runtime**: Check if running under Bun (which has native TS support)
2. **Choose Loader**:
   - **Bun**: Use native `import()` directly (no compilation needed)
   - **Node.js**: Use `tsx` for dynamic TypeScript loading
3. **Import Module**: Dynamically import the compiled/native module
4. **Extract Schema**: Look for `default` export first, then `schema` named export
5. **Validate**: Pass extracted schema through existing `validateSchema()` pipeline

### 3.4 Schema Export Format

Schema files (`.datafn.ts`) MUST export the schema in one of these formats:

**Option 1: Default export (Recommended)**
```typescript
import type { DatafnSchema } from '@datafn/core';

export default {
  resources: [...],
  relations: [...],
} satisfies DatafnSchema;
```

**Option 2: Named export**
```typescript
import type { DatafnSchema } from '@datafn/core';

export const schema: DatafnSchema = {
  resources: [...],
  relations: [...],
};
```

The CLI MUST prioritize `default` export over `schema` named export.

### 3.5 Security Considerations

**Code Execution Boundary**:
- The `.datafn.ts` file IS executed during import
- However, it MUST contain only:
  - Type imports
  - Schema object literal
  - Simple object/array compositions

**Prohibited in `.datafn.ts` files** (enforcement via documentation and community guidelines):
- Network requests
- File system operations
- Process spawning
- Side effects in module scope

**Validation**: The CLI relies on TypeScript compiler and runtime to handle syntax errors. Schema validation is performed by existing `validateSchema()` function.

### 3.6 Dependencies

The CLI package MUST add the following dependencies:

- `tsx` (for Node.js TypeScript loading) - dev dependency or optional peer dependency
- OR rely on Bun's native support when available

### 3.7 Implementation Architecture

```typescript
// New function: resolveSchemaPath()
function resolveSchemaPath(): string {
  if (values.schema) {
    return validateAndResolveExplicitPath(values.schema);
  }
  return autoDiscoverSchema();
}

// New function: validateAndResolveExplicitPath()
function validateAndResolveExplicitPath(path: string): string {
  const ext = extname(path);
  if (!['.json', '.datafn.ts'].includes(ext)) {
    throw new Error(`Invalid schema file extension: ${ext}`);
  }
  return resolve(path);
}

// New function: autoDiscoverSchema()
function autoDiscoverSchema(): string {
  const candidates = [
    './schema.datafn.ts',
    './src/schema.datafn.ts',
    './schema.json',
    './src/schema.json',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      console.log(`✓ Found schema: ${candidate}`);
      return resolve(candidate);
    }
  }

  throw new Error(
    'No schema file found\n' +
    '  Expected: schema.datafn.ts in current directory or src/\n' +
    '  Or provide: --schema <path>'
  );
}

// New function: loadSchema()
async function loadSchema(path: string): Promise<unknown> {
  const ext = extname(path);

  if (ext === '.json') {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  if (ext === '.ts') {
    // This should never happen due to validation, but defensive check
    if (!path.endsWith('.datafn.ts')) {
      throw new Error('TypeScript schema files must use .datafn.ts extension');
    }
    return await loadTypeScriptSchema(path);
  }

  throw new Error(`Unsupported file extension: ${ext}`);
}

// New function: loadTypeScriptSchema()
async function loadTypeScriptSchema(path: string): Promise<unknown> {
  const absolutePath = resolve(path);

  // Dynamic import (works natively in Bun, requires tsx in Node.js)
  const module = await import(absolutePath);

  // Extract schema: prefer default export, fallback to named 'schema' export
  const schema = module.default ?? module.schema;

  if (!schema) {
    throw new Error(
      `No schema export found in ${path}\n` +
      '  Expected: default export or named "schema" export'
    );
  }

  return schema;
}

// Modified: generateTypesCommand()
async function generateTypesCommand() {
  try {
    const schemaPath = resolveSchemaPath();
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

## 4. Specification Type

**Type**: `change`

**Rationale**: This extends existing `generate-types` command functionality with TypeScript file support and auto-discovery, without breaking existing behavior or introducing an entirely new command.

---

## 5. Success Criteria

This specification is considered successfully implemented when:

1. ✅ The CLI accepts `.datafn.ts` files via `--schema` argument
2. ✅ The CLI rejects `.ts` files (without `.datafn.ts` extension) with clear error
3. ✅ The CLI auto-discovers `schema.datafn.ts` when no `--schema` is provided
4. ✅ The CLI falls back to `schema.json` during auto-discovery if `.datafn.ts` not found
5. ✅ TypeScript schemas with default export work correctly
6. ✅ TypeScript schemas with named `schema` export work correctly
7. ✅ Generated types from `.datafn.ts` match output from `.json` (deterministic)
8. ✅ All existing tests continue to pass
9. ✅ New test vectors cover all TypeScript loading scenarios
10. ✅ Documentation includes `.datafn.ts` examples and auto-discovery behavior

---

## 6. Dependencies & Constraints

### 6.1 Internal Dependencies

- `@datafn/core` - `validateSchema()` and `DatafnSchema` type
- `datafn/cli/src/codegen.ts` - `generateTypes()` function
- `datafn/cli/src/cli.ts` - CLI entry point and command dispatch

### 6.2 External Dependencies

- `tsx` (TypeScript loader for Node.js) - conditional/optional
- Node.js `import()` or Bun native TypeScript support

### 6.3 Constraints

- MUST maintain backward compatibility with JSON schemas
- MUST NOT execute arbitrary user code beyond schema imports
- MUST provide deterministic output (same schema → same types)
- MUST work in both Bun and Node.js environments

---

## 7. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Users put arbitrary code in `.datafn.ts` files | Security, stability | Medium | Documentation, community guidelines, file extension enforcement |
| `tsx` dependency bloats package size | Distribution | Low | Make optional or use dynamic import with helpful error if missing |
| Auto-discovery finds wrong file in monorepos | User confusion | Low | Clear documentation of search order, explicit `--schema` option |
| TypeScript compilation errors are unclear | DX | Medium | Catch and wrap errors with helpful context about schema format |

---

## 8. Open Questions

None. All design decisions have been made based on user intent and best practices.

---

## 9. References

- Original issue: `datafn/.conduct/issues/2026-02-13-q8m3k7x5-issue.md`
- Completion report: `datafn/.conduct/issue-completions/2026-02-13-q8m3k7x5-completion.md`
- Example schema: `datafn/examples/todo-app/server/src/schema.ts`
- Test vectors: `datafn/cli/__tests__/codegen.test.ts`
- TypeScript execution tools: tsx (https://github.com/privatenumber/tsx)
