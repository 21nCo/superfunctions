# Phase 02: Unified `generate` CLI Command

**Goal**: Replace `generate-types` and `generate-migration` with a single `generate` command. Remove all migration code.
**Duration Estimate**: 2-3 hours
**Prerequisites**: Phase 01 complete (`generateDrizzleSchema()` available)

---

## In Scope

### Features
- New `generate` command with `--adapter` and `--database` flags
- Both `datafn-schema.drizzle.ts` and `datafn-types.ts` generated in one invocation
- Deprecation notices for `generate-types` and `generate-migration`
- Remove all migration source code
- Update CLI help text
- Update package.json exports

### Technical Components
- Modified: `datafn/cli/src/cli.ts`
- Deleted: `datafn/cli/src/migrations/` (entire directory)
- Deleted: `datafn/cli/__tests__/migrations.test.ts`
- Modified: `datafn/cli/package.json` (remove migration exports)

## Out of Scope
- Drizzle codegen implementation (Phase 01)
- Join table adapter refactor (Phase 03)
- README documentation (Phase 04)

---

## Deliverables

### Modified: `datafn/cli/src/cli.ts`

**Key changes**:

1. **Remove migration imports** (lines 6-11):
```typescript
// DELETE these:
import { diffSchemas } from './migrations/diff.js';
import { generateDrizzleMigration, ... } from './migrations/adapters/index.js';
import { renderPostgres } from './migrations/render-postgres.js';
import { renderMySQL } from './migrations/render-mysql.js';
import { renderSQLite } from './migrations/render-sqlite.js';
import type { MigrationContext } from './migrations/types.js';
```

2. **Add new import**:
```typescript
import { generateDrizzleSchema } from './drizzle-codegen.js';
```

3. **Replace command dispatch** (lines 42-51):
```typescript
(async () => {
  if (command === 'generate') {
    await generateCommand();
  } else if (command === 'generate-types') {
    console.error(`✗ 'generate-types' has been replaced by 'generate'\n  Usage: datafn generate --adapter drizzle --database postgres`);
    process.exit(1);
  } else if (command === 'generate-migration') {
    console.error(`✗ 'generate-migration' has been removed\n  Use your ORM's migration tools instead:\n    drizzle-kit generate\n    drizzle-kit migrate`);
    process.exit(1);
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
})();
```

4. **New `generateCommand()` function**:
```typescript
async function generateCommand() {
  try {
    // Validate required flags
    if (!values.adapter) {
      throw new Error('--adapter is required\n  Supported: drizzle');
    }
    if (!values.database) {
      throw new Error('--database is required\n  Supported: postgres, mysql, sqlite');
    }
    if (values.adapter !== 'drizzle') {
      throw new Error(`Unsupported adapter: ${values.adapter}\n  Currently supported: drizzle`);
    }
    const validDatabases = ['postgres', 'mysql', 'sqlite'];
    if (!validDatabases.includes(values.database)) {
      throw new Error(`Unsupported database: ${values.database}\n  Supported: ${validDatabases.join(', ')}`);
    }

    // Load schema
    const schemaPath = resolveSchemaPath();
    const schema = await loadSchema(schemaPath);

    // Generate Drizzle schema
    const drizzleOutput = generateDrizzleSchema(schema, values.database as any);
    const outputDir = resolve(values.output || './');
    const schemaOutputPath = join(outputDir, 'datafn-schema.drizzle.ts');

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(schemaOutputPath, drizzleOutput);
    console.log(`✓ Schema written to: ${schemaOutputPath}`);

    // Generate client types
    const typesOutput = generateTypes(schema);
    const typesOutputPath = join(outputDir, 'datafn-types.ts');
    writeFileSync(typesOutputPath, typesOutput);
    console.log(`✓ Types written to: ${typesOutputPath}`);
  } catch (err: any) {
    console.error(`✗ Error: ${err.message}`);
    process.exit(1);
  }
}
```

5. **Delete `generateMigration()` function** (lines 181-248)

6. **Delete `generateTypesCommand()` function** (lines 250-263)

7. **Update `printHelp()`**:
```typescript
function printHelp() {
  console.log(`
@datafn/cli - DataFn CLI

Usage:
  datafn <command> [options]

Commands:
  generate              Generate ORM schema and TypeScript types from DataFn schema

Options:
  --adapter <name>     ORM adapter: drizzle (required)
  --database <name>    Database: postgres, mysql, sqlite (required)
  --schema <path>      Path to schema file (.json or .datafn.ts)
                       Optional: Auto-discovers schema.datafn.ts if omitted
  --output <dir>       Output directory (default: ./)
  -h, --help           Show this help message
  -v, --version        Show version

Examples:
  # Generate Drizzle schema + TypeScript types (auto-discover schema)
  datafn generate --adapter drizzle --database postgres

  # Generate from specific schema file
  datafn generate --adapter drizzle --database postgres --schema ./schema.datafn.ts

  # Generate to specific output directory
  datafn generate --adapter drizzle --database sqlite --output ./src/db/

TypeScript Schema Files:
  TypeScript schema files must use the .datafn.ts extension (e.g., schema.datafn.ts)
  Auto-discovery searches in this order:
    1. ./schema.datafn.ts
    2. ./src/schema.datafn.ts
    3. ./schema.json
    4. ./src/schema.json

Production Workflow:
  1. Edit schema.datafn.ts
  2. datafn generate --adapter drizzle --database postgres
  3. drizzle-kit generate  (generates migration SQL)
  4. drizzle-kit migrate   (applies to database)
`);
}
```

### Deleted: Migration Files

Delete the entire `datafn/cli/src/migrations/` directory:
- `diff.ts`
- `render-postgres.ts`
- `render-mysql.ts`
- `render-sqlite.ts`
- `types.ts`
- `adapters/index.ts`
- `adapters/drizzle.ts`
- `adapters/prisma.ts`
- `adapters/kysely.ts`

Delete `datafn/cli/__tests__/migrations.test.ts`.

### Modified: `datafn/cli/package.json`

Remove migration-related exports from `"exports"` field (if any).

Remove `--from` and `--to` CLI options from parseArgs (no longer needed).

---

## Requirements Covered

- **FR-CLI-001**: Unified generate command ✅
- **FR-REM-GT-001**: Remove generate-types ✅
- **FR-REM-GM-001**: Remove generate-migration ✅
- **FR-REM-MIG-001**: Remove migration code ✅

---

## Implementation Tasks

### Task 2.1: New Generate Command
- [ ] Add `generateCommand()` function
- [ ] Wire up `generate` in command dispatch
- [ ] Validate `--adapter` and `--database` flags
- [ ] Call `generateDrizzleSchema()` + `generateTypes()`
- [ ] Write both output files

### Task 2.2: Deprecation Notices
- [ ] Add `generate-types` deprecation message
- [ ] Add `generate-migration` deprecation message
- [ ] Both exit with code 1

### Task 2.3: Remove Migration Code
- [ ] Delete `migrations/` directory
- [ ] Delete `migrations.test.ts`
- [ ] Remove migration imports from `cli.ts`
- [ ] Remove `generateMigration()` function
- [ ] Remove `generateTypesCommand()` function
- [ ] Clean up `parseArgs` options (remove `--from`, `--to`)

### Task 2.4: Update Help Text
- [ ] Rewrite `printHelp()` for `generate` command
- [ ] Include production workflow section
- [ ] Include auto-discovery documentation

### Task 2.5: Update Package Exports
- [ ] Remove migration-related exports from package.json
- [ ] Add `generateDrizzleSchema` to exports
- [ ] Verify package compiles

### Task 2.6: Integration Tests
- [ ] Test `generate` command end-to-end
- [ ] Test deprecation notices
- [ ] Test missing flag errors
- [ ] Test unsupported adapter error

---

## Verification Steps

### Automated Testing
```bash
cd datafn/cli && npm test
```

### Manual Testing
1. `datafn generate --adapter drizzle --database postgres` → two files generated
2. `datafn generate-types` → deprecation notice
3. `datafn generate-migration` → deprecation notice
4. `datafn generate` → error about missing --adapter
5. `datafn --help` → updated help text

---

## Stop Condition

✅ Phase 02 is complete when:
1. `datafn generate --adapter drizzle --database postgres` generates both files
2. Old commands print deprecation notices
3. Missing/invalid flags produce clear errors
4. All migration code deleted
5. CLI compiles without migration imports
6. All TV-CLI-* test vectors pass

---

## Risks & Issues

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking change for generate-migration users | High | Medium | Clear deprecation message with alternative |
| Missing export cleanup | Low | Low | TypeScript compiler will catch |
| Leftover migration test references | Low | Low | CI will catch test failures |

---

## Rollback Plan

Revert `cli.ts` changes and restore `migrations/` directory from git. Phase 01 code (`drizzle-codegen.ts`) is independent and can stay.
