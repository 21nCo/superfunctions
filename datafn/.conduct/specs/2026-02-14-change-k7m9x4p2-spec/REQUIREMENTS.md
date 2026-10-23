# Requirements Specification

## Requirement Categories

- **MUST**: Mandatory, non-negotiable requirements
- **SHOULD**: Recommended, highly desirable requirements
- **MAY**: Optional, nice-to-have requirements

---

## FR: Functional Requirements

### FR-1: File Extension Validation

**ID**: `FR-EXT-001`
**Category**: MUST
**Description**: The CLI MUST accept only `.datafn.ts` and `.json` file extensions for schema files.

**Acceptance Criteria**:
- Files ending with `.datafn.ts` are accepted
- Files ending with `.json` are accepted
- Files ending with `.ts` (without `.datafn.`) are rejected with error
- Files with other extensions (`.js`, `.yaml`, etc.) are rejected with error
- Error messages MUST clearly state expected extensions

**Positive Tests**:
- CLI accepts `schema.datafn.ts`
- CLI accepts `my-schema.datafn.ts`
- CLI accepts `schema.json`

**Negative Tests**:
- CLI rejects `schema.ts` with error message
- CLI rejects `schema.js` with error message
- CLI rejects `schema.yaml` with error message

---

### FR-2: Auto-Discovery Mechanism

**ID**: `FR-DISC-001`
**Category**: MUST
**Description**: When `--schema` flag is NOT provided, the CLI MUST search for schema files in a defined order.

**Acceptance Criteria**:
- Search occurs in this exact order:
  1. `./schema.datafn.ts`
  2. `./src/schema.datafn.ts`
  3. `./schema.json`
  4. `./src/schema.json`
- First file found is used
- If no file found, CLI exits with clear error listing search paths
- CLI logs which file was discovered (e.g., "✓ Found schema: ./schema.datafn.ts")

**Positive Tests**:
- Auto-discovers `./schema.datafn.ts` when present
- Auto-discovers `./src/schema.datafn.ts` when `./schema.datafn.ts` absent
- Auto-discovers `./schema.json` when no `.datafn.ts` files present
- Prefers `.datafn.ts` over `.json` when both exist

**Negative Tests**:
- Exits with error when no schema files exist in any search path
- Error message lists all 4 search paths

---

### FR-3: TypeScript Schema Loading

**ID**: `FR-TS-001`
**Category**: MUST
**Description**: The CLI MUST load and execute `.datafn.ts` files to extract schema definitions.

**Acceptance Criteria**:
- `.datafn.ts` files are dynamically imported
- TypeScript compilation occurs transparently (Bun native or tsx)
- Import errors are caught and wrapped with helpful context
- Module evaluation completes before schema extraction

**Positive Tests**:
- Successfully imports valid `.datafn.ts` file
- Successfully compiles TypeScript syntax (types, interfaces, satisfies)
- Works in both Bun and Node.js environments

**Negative Tests**:
- Reports syntax errors in `.datafn.ts` with file path context
- Reports import errors with helpful message

---

### FR-4: Schema Export Extraction

**ID**: `FR-EXPORT-001`
**Category**: MUST
**Description**: The CLI MUST extract schema from either default export or named `schema` export, prioritizing default export.

**Acceptance Criteria**:
- Default export is extracted when present
- Named `schema` export is extracted when default absent
- Error is thrown when neither export exists
- Priority: `default` > `schema` named export

**Positive Tests**:
- Extracts schema from `export default { ... }`
- Extracts schema from `export const schema = { ... }`
- Uses `default` when both `default` and `schema` exports exist

**Negative Tests**:
- Exits with error when no default or schema export found
- Error message specifies expected export formats

---

### FR-5: Schema Validation

**ID**: `FR-VAL-001`
**Category**: MUST
**Description**: All loaded schemas (TypeScript or JSON) MUST be validated using existing `validateSchema()` function.

**Acceptance Criteria**:
- `validateSchema()` is called on extracted schema object
- Validation errors are caught and reported clearly
- Invalid schemas from `.datafn.ts` are rejected same as invalid JSON

**Positive Tests**:
- Valid schema from `.datafn.ts` passes validation
- Schema validation errors reference the source file

**Negative Tests**:
- Invalid schema from `.datafn.ts` is rejected with validation error
- Validation error includes schema file path for debugging

---

### FR-6: Type Generation Consistency

**ID**: `FR-GEN-001`
**Category**: MUST
**Description**: Generated TypeScript types MUST be identical whether schema source is `.datafn.ts` or `.json`.

**Acceptance Criteria**:
- Same schema content produces identical TypeScript output
- Output is deterministic (same input → same output)
- Field ordering follows existing alphabetical sorting rules

**Positive Tests**:
- Identical schemas in `.json` and `.datafn.ts` produce identical output
- Multiple runs with same `.datafn.ts` produce identical output

**Negative Tests**: N/A (consistency is positive-only verification)

---

### FR-7: Explicit Schema Path Override

**ID**: `FR-PATH-001`
**Category**: MUST
**Description**: When `--schema <path>` is provided, the CLI MUST use that path and skip auto-discovery.

**Acceptance Criteria**:
- Provided path is validated for extension (`.json` or `.datafn.ts`)
- Auto-discovery does NOT run when `--schema` is present
- Relative and absolute paths are supported
- Path resolution is relative to current working directory

**Positive Tests**:
- Uses explicit `--schema ./custom.datafn.ts`
- Uses explicit `--schema /absolute/path/schema.datafn.ts`
- Uses explicit `--schema ../parent/schema.json`

**Negative Tests**:
- Rejects `--schema ./invalid.ts` with extension error
- Reports file not found error for non-existent paths

---

### FR-8: Backward Compatibility with JSON

**ID**: `FR-COMPAT-001`
**Category**: MUST
**Description**: Existing JSON schema workflow MUST remain fully functional and unchanged.

**Acceptance Criteria**:
- `--schema ./schema.json` continues to work
- JSON parsing uses existing `JSON.parse()` logic
- JSON schema validation unchanged
- All existing JSON-based tests pass

**Positive Tests**:
- All existing tests with JSON schemas pass
- `datafn generate-types --schema ./schema.json` works identically to pre-change behavior

**Negative Tests**: N/A (backward compatibility verified by existing test suite)

---

### FR-9: Error Messages

**ID**: `FR-ERR-001`
**Category**: MUST
**Description**: All error conditions MUST produce clear, actionable error messages.

**Acceptance Criteria**:
- Extension validation errors state expected extensions
- Auto-discovery failures list search paths
- Missing export errors show expected formats
- Validation errors reference source file
- Import/compilation errors include file path

**Positive Tests**: N/A (error handling is tested via negative tests)

**Negative Tests**:
- Each error condition produces message with required context
- Error messages include fix suggestions where applicable

---

### FR-10: CLI Help Documentation

**ID**: `FR-HELP-001`
**Category**: MUST
**Description**: The `--help` output MUST document TypeScript schema support and auto-discovery.

**Acceptance Criteria**:
- Help text mentions `.datafn.ts` extension
- Help text explains auto-discovery behavior
- Examples include both `.json` and `.datafn.ts` usage
- Examples show zero-config usage (no `--schema` flag)

**Positive Tests**:
- `datafn generate-types --help` includes `.datafn.ts` in description
- Help text includes example: `datafn generate-types` (zero config)
- Help text includes example: `datafn generate-types --schema ./schema.datafn.ts`

**Negative Tests**: N/A (documentation verification)

---

## NFR: Non-Functional Requirements

### NFR-1: Performance

**ID**: `NFR-PERF-001`
**Category**: SHOULD
**Description**: TypeScript schema loading SHOULD add no more than 200ms overhead compared to JSON loading.

**Acceptance Criteria**:
- TypeScript compilation/import completes within acceptable time
- No noticeable CLI slowdown for typical schema sizes

**Testing**: Benchmark JSON vs TypeScript loading for identical schemas

---

### NFR-2: Cross-Runtime Compatibility

**ID**: `NFR-RUNTIME-001`
**Category**: MUST
**Description**: The CLI MUST work in both Bun and Node.js runtimes.

**Acceptance Criteria**:
- TypeScript loading works natively in Bun
- TypeScript loading works in Node.js (via tsx or similar)
- Runtime detection is automatic
- Fallback error is clear if required tools missing

**Positive Tests**:
- CLI works with `.datafn.ts` when run via Bun
- CLI works with `.datafn.ts` when run via Node.js with tsx available

**Negative Tests**:
- CLI provides helpful error if Node.js lacks TypeScript loader

---

### NFR-3: Dependency Footprint

**ID**: `NFR-DEP-001`
**Category**: SHOULD
**Description**: TypeScript loading dependencies SHOULD be optional or minimal.

**Acceptance Criteria**:
- `tsx` is optional dependency or peer dependency
- CLI works without `tsx` when using Bun
- Package size increase is minimal (<500KB)

**Testing**: Verify package.json dependencies and bundle size

---

### NFR-4: Security

**ID**: `NFR-SEC-001`
**Category**: MUST
**Description**: The CLI MUST minimize arbitrary code execution risk.

**Acceptance Criteria**:
- Only `.datafn.ts` files can be executed (not arbitrary `.ts`)
- Documentation warns against side effects in schema files
- File extension enforcement prevents accidental execution

**Testing**:
- Verify `.ts` files are rejected
- Document best practices for `.datafn.ts` contents

---

## Test Coverage Requirements

### TC-1: Unit Tests

**ID**: `TC-UNIT-001`
**Category**: MUST

**Required Test Cases**:
1. `resolveSchemaPath()` with explicit path
2. `resolveSchemaPath()` with auto-discovery
3. `validateAndResolveExplicitPath()` for each extension
4. `autoDiscoverSchema()` for each search location
5. `loadSchema()` for `.json` files
6. `loadSchema()` for `.datafn.ts` files
7. `loadTypeScriptSchema()` with default export
8. `loadTypeScriptSchema()` with named export
9. Extension validation logic
10. Error message formatting

---

### TC-2: Integration Tests

**ID**: `TC-INT-001`
**Category**: MUST

**Required Test Cases**:
1. End-to-end: `datafn generate-types --schema ./test.datafn.ts`
2. End-to-end: `datafn generate-types` (auto-discovery)
3. End-to-end: TypeScript vs JSON output consistency
4. Error paths: missing file, invalid extension, no export
5. Regression: all existing JSON tests still pass

---

### TC-3: Test Vectors

**ID**: `TC-VEC-001`
**Category**: MUST

**Required Test Vectors**:
- `TV-TS-LOAD-001`: Load schema from `.datafn.ts` with default export
- `TV-TS-LOAD-002`: Load schema from `.datafn.ts` with named export
- `TV-TS-DISC-001`: Auto-discover `./schema.datafn.ts`
- `TV-TS-DISC-002`: Auto-discover `./src/schema.datafn.ts`
- `TV-TS-CONS-001`: Output consistency between `.ts` and `.json`
- `TV-TS-ERR-001`: Reject `.ts` without `.datafn.` extension
- `TV-TS-ERR-002`: Reject missing export
- `TV-TS-ERR-003`: Auto-discovery failure error

---

## Requirements Coverage Summary

| Requirement ID | Category | Test Coverage |
|----------------|----------|---------------|
| FR-EXT-001     | MUST     | TC-UNIT-001, TC-INT-001, TV-TS-ERR-001 |
| FR-DISC-001    | MUST     | TC-UNIT-001, TC-INT-001, TV-TS-DISC-001, TV-TS-DISC-002 |
| FR-TS-001      | MUST     | TC-UNIT-001, TC-INT-001, TV-TS-LOAD-001 |
| FR-EXPORT-001  | MUST     | TC-UNIT-001, TV-TS-LOAD-001, TV-TS-LOAD-002, TV-TS-ERR-002 |
| FR-VAL-001     | MUST     | TC-INT-001 |
| FR-GEN-001     | MUST     | TC-INT-001, TV-TS-CONS-001 |
| FR-PATH-001    | MUST     | TC-UNIT-001, TC-INT-001 |
| FR-COMPAT-001  | MUST     | TC-INT-001 (existing tests) |
| FR-ERR-001     | MUST     | TC-INT-001, TV-TS-ERR-* |
| FR-HELP-001    | MUST     | Manual verification |
| NFR-PERF-001   | SHOULD   | Benchmark testing |
| NFR-RUNTIME-001| MUST     | TC-INT-001 (both runtimes) |
| NFR-DEP-001    | SHOULD   | Package analysis |
| NFR-SEC-001    | MUST     | TC-INT-001, TV-TS-ERR-001 |
