# Test Vectors

## Overview

This document defines concrete test vectors for CLI TypeScript schema support. Each test vector specifies inputs, expected outputs, and verification criteria.

---

## TV-TS-LOAD-001: Load Schema from TypeScript with Default Export

**Requirement Coverage**: FR-TS-001, FR-EXPORT-001

**Input File**: `test-schema-default.datafn.ts`
```typescript
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

**Command**:
```bash
datafn generate-types --schema ./test-schema-default.datafn.ts --output ./output.ts
```

**Expected Output**: Exit code 0, file `./output.ts` created

**Expected Content** (output.ts):
```typescript
import type { DatafnClient, DatafnTable } from "@datafn/client";

export interface Task {
  id: string;
  title: string;
}

export interface Tables {
  task: Task;
}

export type TypedClient = DatafnClient & {
  task: DatafnTable<Task>;
};
```

**Verification**:
- File created successfully
- Output matches expected TypeScript
- No errors logged

---

## TV-TS-LOAD-002: Load Schema from TypeScript with Named Export

**Requirement Coverage**: FR-EXPORT-001

**Input File**: `test-schema-named.datafn.ts`
```typescript
import type { DatafnSchema } from '@datafn/core';

export const schema: DatafnSchema = {
  resources: [
    {
      name: 'goal',
      version: 1,
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'target', type: 'number', required: true },
      ],
    },
  ],
  relations: [],
};
```

**Command**:
```bash
datafn generate-types --schema ./test-schema-named.datafn.ts --output ./output.ts
```

**Expected Output**: Exit code 0, file `./output.ts` created

**Expected Content** (output.ts):
```typescript
import type { DatafnClient, DatafnTable } from "@datafn/client";

export interface Goal {
  id: string;
  target: number;
}

export interface Tables {
  goal: Goal;
}

export type TypedClient = DatafnClient & {
  goal: DatafnTable<Goal>;
};
```

**Verification**:
- Named export extracted correctly
- Output matches expected TypeScript
- No errors logged

---

## TV-TS-DISC-001: Auto-Discover schema.datafn.ts in Root

**Requirement Coverage**: FR-DISC-001

**Setup**:
- Create `./schema.datafn.ts` in current directory
- Ensure no `./src/schema.datafn.ts` exists
- Ensure no `./schema.json` exists

**Input File**: `./schema.datafn.ts`
```typescript
export default {
  resources: [
    { name: 'user', version: 1, fields: [{ name: 'id', type: 'string', required: true }] },
  ],
  relations: [],
};
```

**Command**:
```bash
datafn generate-types
```

**Expected Output**:
- Exit code 0
- Console log: `✓ Found schema: ./schema.datafn.ts`
- Console log: `✓ Types written to: ./datafn-types.ts`
- File `./datafn-types.ts` created

**Verification**:
- Auto-discovery finds root-level file
- Correct file logged as discovered
- Types generated successfully

---

## TV-TS-DISC-002: Auto-Discover schema.datafn.ts in src/

**Requirement Coverage**: FR-DISC-001

**Setup**:
- Ensure no `./schema.datafn.ts` exists
- Create `./src/schema.datafn.ts`
- Ensure no `./schema.json` exists

**Input File**: `./src/schema.datafn.ts`
```typescript
export default {
  resources: [
    { name: 'post', version: 1, fields: [{ name: 'id', type: 'string', required: true }] },
  ],
  relations: [],
};
```

**Command**:
```bash
datafn generate-types
```

**Expected Output**:
- Exit code 0
- Console log: `✓ Found schema: ./src/schema.datafn.ts`
- Console log: `✓ Types written to: ./datafn-types.ts`
- File `./datafn-types.ts` created

**Verification**:
- Auto-discovery falls back to src/ directory
- Correct file logged as discovered
- Types generated successfully

---

## TV-TS-DISC-003: Auto-Discover Fallback to JSON

**Requirement Coverage**: FR-DISC-001, FR-COMPAT-001

**Setup**:
- Ensure no `./schema.datafn.ts` exists
- Ensure no `./src/schema.datafn.ts` exists
- Create `./schema.json`

**Input File**: `./schema.json`
```json
{
  "resources": [
    {
      "name": "comment",
      "version": 1,
      "fields": [{ "name": "id", "type": "string", "required": true }]
    }
  ],
  "relations": []
}
```

**Command**:
```bash
datafn generate-types
```

**Expected Output**:
- Exit code 0
- Console log: `✓ Found schema: ./schema.json`
- File `./datafn-types.ts` created

**Verification**:
- Auto-discovery falls back to JSON
- JSON schema loaded correctly
- Backward compatibility maintained

---

## TV-TS-DISC-004: Auto-Discover Prefers TypeScript over JSON

**Requirement Coverage**: FR-DISC-001

**Setup**:
- Create both `./schema.datafn.ts` AND `./schema.json`
- Both files contain different schemas

**Input Files**:

`./schema.datafn.ts`:
```typescript
export default {
  resources: [{ name: 'ts_resource', version: 1, fields: [] }],
  relations: [],
};
```

`./schema.json`:
```json
{
  "resources": [{ "name": "json_resource", "version": 1, "fields": [] }],
  "relations": []
}
```

**Command**:
```bash
datafn generate-types
```

**Expected Output**:
- Exit code 0
- Console log: `✓ Found schema: ./schema.datafn.ts`
- Output contains `TsResource` interface, NOT `JsonResource`

**Verification**:
- TypeScript file is prioritized
- JSON file is ignored when TS file exists
- Search order is respected

---

## TV-TS-CONS-001: TypeScript vs JSON Output Consistency

**Requirement Coverage**: FR-GEN-001

**Input Files**:

`./schema.datafn.ts`:
```typescript
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
};
```

`./schema.json`:
```json
{
  "resources": [
    {
      "name": "task",
      "version": 1,
      "fields": [
        { "name": "id", "type": "string", "required": true },
        { "name": "title", "type": "string", "required": true },
        { "name": "done", "type": "boolean", "required": false }
      ]
    }
  ],
  "relations": []
}
```

**Commands**:
```bash
datafn generate-types --schema ./schema.datafn.ts --output ./output-ts.ts
datafn generate-types --schema ./schema.json --output ./output-json.ts
```

**Expected Output**:
- Both commands succeed
- `./output-ts.ts` and `./output-json.ts` have IDENTICAL content

**Verification**:
- File content comparison: `diff output-ts.ts output-json.ts` produces no output
- Deterministic generation verified

---

## TV-TS-ERR-001: Reject .ts Files Without .datafn. Extension

**Requirement Coverage**: FR-EXT-001, NFR-SEC-001

**Input File**: `./schema.ts` (note: NOT `.datafn.ts`)
```typescript
export default {
  resources: [],
  relations: [],
};
```

**Command**:
```bash
datafn generate-types --schema ./schema.ts
```

**Expected Output**:
- Exit code 1
- Error message contains:
  - "Invalid schema file extension"
  - "Expected: *.datafn.ts or *.json"
  - "Got: schema.ts"
  - "TypeScript schema files must use .datafn.ts extension for security"

**Verification**:
- CLI exits with error
- Error message is clear and actionable
- File is NOT processed

---

## TV-TS-ERR-002: Reject Missing Schema Export

**Requirement Coverage**: FR-EXPORT-001

**Input File**: `./no-export.datafn.ts`
```typescript
import type { DatafnSchema } from '@datafn/core';

const mySchema: DatafnSchema = {
  resources: [],
  relations: [],
};

// Note: no export statement
```

**Command**:
```bash
datafn generate-types --schema ./no-export.datafn.ts
```

**Expected Output**:
- Exit code 1
- Error message contains:
  - "No schema export found in no-export.datafn.ts"
  - "Expected: default export or named \"schema\" export"

**Verification**:
- CLI exits with error
- Error message specifies expected export formats
- No types file generated

---

## TV-TS-ERR-003: Auto-Discovery Failure Error

**Requirement Coverage**: FR-DISC-001, FR-ERR-001

**Setup**:
- Ensure NO schema files exist in any search location:
  - No `./schema.datafn.ts`
  - No `./src/schema.datafn.ts`
  - No `./schema.json`
  - No `./src/schema.json`

**Command**:
```bash
datafn generate-types
```

**Expected Output**:
- Exit code 1
- Error message contains:
  - "No schema file found"
  - "Expected: schema.datafn.ts in current directory or src/"
  - "Or provide: --schema <path>"

**Verification**:
- CLI exits with error
- Error message lists search locations
- Error message suggests solution (`--schema` flag)

---

## TV-TS-ERR-004: Invalid TypeScript Syntax Error

**Requirement Coverage**: FR-TS-001, FR-ERR-001

**Input File**: `./invalid-syntax.datafn.ts`
```typescript
export default {
  resources: [
    { name: 'broken' version: 1 }  // Missing comma - syntax error
  ],
  relations: [],
};
```

**Command**:
```bash
datafn generate-types --schema ./invalid-syntax.datafn.ts
```

**Expected Output**:
- Exit code 1
- Error message contains reference to:
  - File path: `invalid-syntax.datafn.ts`
  - Syntax error details from TypeScript compiler

**Verification**:
- CLI exits with error
- Error provides enough context to debug
- File path is included in error message

---

## TV-TS-ERR-005: Schema Validation Failure from TypeScript

**Requirement Coverage**: FR-VAL-001

**Input File**: `./invalid-schema.datafn.ts`
```typescript
export default {
  resources: [
    {
      name: 'invalid',
      version: 1,
      // Missing required 'fields' property
    },
  ],
  relations: [],
};
```

**Command**:
```bash
datafn generate-types --schema ./invalid-schema.datafn.ts
```

**Expected Output**:
- Exit code 1
- Error message contains:
  - Schema validation error from `validateSchema()`
  - Error code: `SCHEMA_INVALID`
  - Details about missing/invalid fields

**Verification**:
- Validation occurs after TypeScript loading
- Validation errors are clear
- Same validation applies to TS and JSON

---

## TV-TS-PATH-001: Explicit Path with Relative Directory

**Requirement Coverage**: FR-PATH-001

**Input File**: `./config/custom-schema.datafn.ts`
```typescript
export default {
  resources: [{ name: 'item', version: 1, fields: [] }],
  relations: [],
};
```

**Command**:
```bash
datafn generate-types --schema ./config/custom-schema.datafn.ts --output ./types.ts
```

**Expected Output**:
- Exit code 0
- File `./types.ts` created with Item interface

**Verification**:
- Relative paths resolve correctly
- Subdirectory schemas are accessible
- Auto-discovery is bypassed

---

## TV-TS-HELP-001: Help Text Includes TypeScript Documentation

**Requirement Coverage**: FR-HELP-001

**Command**:
```bash
datafn generate-types --help
```

**Expected Output**:
- Help text includes:
  - Mention of `.datafn.ts` extension
  - Description of auto-discovery
  - Example with `--schema schema.datafn.ts`
  - Example with zero-config usage (no flags)

**Expected Content** (excerpt):
```
Commands:
  generate-types        Generate TypeScript types from schema

Options:
  --schema <path>      Path to schema file (.json or .datafn.ts)
                       Optional: Auto-discovers schema.datafn.ts if omitted
  --output <path>      Output file path (default: ./datafn-types.ts)

Examples:
  # Auto-discover schema (zero config)
  datafn generate-types

  # Explicit TypeScript schema
  datafn generate-types --schema ./schema.datafn.ts

  # Explicit JSON schema
  datafn generate-types --schema ./schema.json --output ./src/types.ts
```

**Verification**:
- Documentation is clear and comprehensive
- Examples cover all major use cases
- Auto-discovery is explained

---

## Test Vector Coverage Summary

| Test Vector        | Requirements Covered                    | Type     |
|--------------------|-----------------------------------------|----------|
| TV-TS-LOAD-001     | FR-TS-001, FR-EXPORT-001                | Positive |
| TV-TS-LOAD-002     | FR-EXPORT-001                           | Positive |
| TV-TS-DISC-001     | FR-DISC-001                             | Positive |
| TV-TS-DISC-002     | FR-DISC-001                             | Positive |
| TV-TS-DISC-003     | FR-DISC-001, FR-COMPAT-001              | Positive |
| TV-TS-DISC-004     | FR-DISC-001                             | Positive |
| TV-TS-CONS-001     | FR-GEN-001                              | Positive |
| TV-TS-ERR-001      | FR-EXT-001, NFR-SEC-001                 | Negative |
| TV-TS-ERR-002      | FR-EXPORT-001                           | Negative |
| TV-TS-ERR-003      | FR-DISC-001, FR-ERR-001                 | Negative |
| TV-TS-ERR-004      | FR-TS-001, FR-ERR-001                   | Negative |
| TV-TS-ERR-005      | FR-VAL-001                              | Negative |
| TV-TS-PATH-001     | FR-PATH-001                             | Positive |
| TV-TS-HELP-001     | FR-HELP-001                             | Positive |

**Total Test Vectors**: 14 (9 positive, 5 negative)
