# SPEC: Schema Index Validation & Type-Safe Schema Declarations

## Metadata

| Field | Value |
|---|---|
| Timestamp | 2026-02-16T13:00:00Z |
| Agent | claude-opus-4-6 |
| Model | Claude Opus 4.6 |
| Launcher | VS Code (Claude Code Extension) |
| Workspace | /Users/serro/Documents/dev/n/superfunctions |
| OS / Shell | Darwin 25.2.0 / zsh |
| Git Branch | next |
| Git Commit | 2d1a0bf (dirty) |
| Spec Folder | 2026-02-16-new-k9m7x3p5-spec |
| Spec Path | datafn/.conduct/specs/2026-02-16-new-k9m7x3p5-spec |
| Spec Type | new |
| Spec ID | k9m7x3p5 |
| Input Paths | datafn/core/src/schema.ts, datafn/core/src/types.ts, datafn/core/src/index.ts, datafn/cli/src/cli.ts, datafn/cli/src/drizzle-codegen.ts, datafn/examples/todo-app/server/src/schema.datafn.ts |

---

## Overview

DataFn CLI's `generate` command produces Drizzle ORM schema files from a `DatafnSchema` definition. Currently, if a user specifies an index field name that does not match any declared field (e.g. `"created_at"` in `indices.base` when the field is named `"createdAt"`), the codegen silently produces invalid TypeScript (e.g. `table.created_at` instead of `table.createdAt`). There is no runtime validation, no standalone validation command, and no compile-time type safety to catch this class of error.

This spec introduces three complementary safeguards:

1. **Runtime validation** — `validateSchema()` rejects schemas where index field names do not match any field in the resource, with a clear error message listing available fields.
2. **`validate` CLI command** — A standalone command (`datafn validate`) that loads and validates a schema without generating files.
3. **Type-safe `defineSchema()` helper** — A generic TypeScript function that constrains `indices` entries to the literal union of field names declared in the same resource, producing compile-time errors for mismatches.

---

## Glossary

| Term | Definition |
|---|---|
| **DatafnSchema** | The top-level schema object containing `resources` and optional `relations`. |
| **Resource** | A named entity (table) with fields, indices, and permissions. |
| **Field name** | The camelCase JavaScript property name of a field (e.g. `"createdAt"`). |
| **Column name** | The snake_case SQL column name derived from the field name (e.g. `"created_at"`). |
| **Index field** | A string in `indices.base`, `indices.search`, or `indices.vector` that references a field. |
| **`validateSchema()`** | The existing schema validation function in `@datafn/core` that normalizes and validates `DatafnSchema` objects. |
| **`defineSchema()`** | The new helper function that provides compile-time type safety for schema declarations. |
| **Drizzle codegen** | The code generator that produces Drizzle ORM table definitions from a `DatafnSchema`. |

---

## Goals

1. Invalid index field names MUST be caught at schema validation time with an actionable error message.
2. Users MUST be able to validate a schema file without generating output files.
3. Users SHOULD get compile-time TypeScript errors when index field names don't match declared fields in `.datafn.ts` files.

## Non-Goals

- Automatic correction or "did you mean?" suggestions for mismatched index names (nice-to-have, not in scope).
- Validation of relation field references (e.g. `from`/`to` resource names) — existing behavior is unchanged.
- Changes to the Drizzle codegen output format or column naming conventions.
- JSON Schema validation or schema file format changes.

---

## Public API

### 1. `validateSchema()` — Enhanced (existing function)

**File:** `datafn/core/src/schema.ts`

```ts
export function validateSchema(schema: unknown): DatafnEnvelope<DatafnSchema>
```

**New behavior:** After normalizing indices, validates that every entry in `base`, `search`, and `vector` matches a field name from the resource's `fields` array. Returns an error envelope with code `"SCHEMA_INVALID"` if any index field is unrecognized.

### 2. `defineSchema()` — New function

**File:** `datafn/core/src/types.ts`
**Export:** `datafn/core/src/index.ts`

```ts
export function defineSchema<
  const T extends DatafnSchemaDefinition<T["resources"]>
>(schema: T): DatafnSchema
```

Returns the input cast to `DatafnSchema`. The generic constraint provides compile-time validation that `indices` entries match declared field names. The `const` type parameter preserves literal string types.

### 3. `datafn validate` — New CLI command

**File:** `datafn/cli/src/cli.ts`

```
datafn validate [--schema <path>]
```

Loads the schema file (using the same auto-discovery and loading logic as `generate`), runs `validateSchema()`, and prints a success/failure message. Exits with code 0 on success, 1 on validation failure.

---

## Data Formats / Protocol

### Error envelope (existing pattern)

```ts
// On index validation failure:
{
  ok: false,
  error: {
    code: "SCHEMA_INVALID",
    message: 'Invalid schema: index field "created_at" in indices.base does not match any field in resource "todos". Available fields: id, text, completed, priority, createdAt, updatedAt',
    context: { path: "resources.todos.indices.base" }
  }
}
```

---

## Semantics

### Index field resolution

- Index field names MUST match a field `name` property exactly (case-sensitive, character-exact).
- There is no fuzzy matching or snake_case-to-camelCase conversion. If the user writes `"created_at"` and the field is `"createdAt"`, this is a validation error.
- This is intentional: the schema's canonical field identifier is the camelCase `name` property. Teaching the validator to accept both conventions would mask errors.

### Validation ordering

- Index field validation runs AFTER field uniqueness validation and index normalization (converting `string[]` shorthand to `{ base, search, vector }` form).
- This means all three index categories (`base`, `search`, `vector`) are validated.

### `defineSchema()` semantics

- `defineSchema()` is a pure identity function at runtime — it returns its input unchanged (cast to `DatafnSchema`).
- All value is at compile time via the generic constraint.
- It does NOT call `validateSchema()` at runtime. Runtime validation happens in the CLI commands.

---

## Invariants

1. **No silent invalid output:** If `validateSchema()` succeeds, all index field names reference valid fields. Codegen can trust this.
2. **Backward compatibility:** Existing valid schemas continue to pass validation. Only schemas with index fields that don't match any field name are newly rejected.
3. **`defineSchema()` is optional:** Users may continue using `DatafnSchema` type annotation directly. `defineSchema()` adds type safety but is not required.

---

## Security

No security implications. This is a developer-time validation feature.

---

## Limits / Caps

No new limits introduced.

---

## Observability

- The `validate` CLI command prints `✓ Schema is valid: <path>` on success.
- On failure, it prints `✗ Error: <message>` with the full validation error and exits with code 1.
- No telemetry or logging beyond the existing CLI output pattern.

---

## Compatibility / Versioning

- **Breaking change:** Schemas that previously passed validation but had invalid index field names will now fail. This is the intended fix — those schemas produced broken Drizzle output anyway.
- **`defineSchema()`** requires TypeScript 5.0+ for `const` type parameters. This is already the minimum TypeScript version for the datafn ecosystem.
- No changes to the `DatafnSchema` runtime type. `defineSchema()` returns `DatafnSchema`.

---

## Undefined / Explicitly Deferred

- "Did you mean?" suggestions for mismatched index field names.
- Validation of relation resource name references.
- Index field validation for compound/multi-column indices (not currently supported in the schema).
