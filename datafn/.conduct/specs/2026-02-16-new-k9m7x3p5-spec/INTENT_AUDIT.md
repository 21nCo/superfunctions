# INTENT AUDIT: Schema Index Validation & Type-Safe Schema Declarations

## Intent Inventory

Extracted from the user's conversation and requests:

| # | Intent Item |
|---|---|
| 1 | CLI should throw a runtime error when index field names don't match any declared field in the resource |
| 2 | The error message should explain WHY the schema is invalid (which field is wrong, what's available) |
| 3 | CLI should provide a `validate` command to validate a datafn schema without generating files |
| 4 | Schema declarations should be type-safe — TypeScript should show compile-time errors for invalid index field names |
| 5 | The type-safe approach should use a helper function (e.g. `defineSchema()`) |
| 6 | The example todo-app schema has `"created_at"` in indices which should be `"createdAt"` — must be fixed |
| 7 | The example should demonstrate the type-safe pattern |

## Coverage Mapping

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vectors |
|---|---|---|---|---|
| 1 | Runtime error for invalid index fields | Semantics → Index field resolution; Public API → validateSchema() | VAL-001, VAL-003, VAL-004 | TV-VAL-001, TV-VAL-002, TV-VAL-004, TV-VAL-005, TV-VAL-006 |
| 2 | Actionable error message with available fields | Data Formats → Error envelope | VAL-002 | TV-VAL-001, TV-VAL-002 |
| 3 | CLI `validate` command | Public API → datafn validate | CLI-001, CLI-002, CLI-003, CLI-004 | TV-CLI-001, TV-CLI-002 |
| 4 | Compile-time type safety for index fields | Public API → defineSchema(); Semantics → defineSchema() semantics | TYP-002 | TV-TYP-002, TV-TYP-003 |
| 5 | `defineSchema()` helper function | Public API → defineSchema() | TYP-001, TYP-003, TYP-004 | TV-TYP-001, TV-TYP-004 |
| 6 | Fix example schema index field name | N/A (fix, not spec feature) | FIX-001 | N/A (manual verification) |
| 7 | Example should use defineSchema() | N/A (example best practice) | FIX-002 | N/A (manual verification) |

## Completeness Assessment

**No missing intent items.** Every intent from the user's conversation is covered by at least one requirement, mapped to specific spec sections, and verified by test vectors where applicable.

### Additional coverage notes:

- **Backward compatibility** (intent implied): Covered by VAL-005 and TYP-004 — existing schemas without `defineSchema()` continue to work, and valid schemas continue to pass validation.
- **All index categories validated** (implicit requirement): Covered by VAL-003 — not just `base`, but also `search` and `vector`.
- **Shorthand indices** (edge case): Covered by VAL-004 and TV-VAL-006 — the `string[]` shorthand form is normalized before validation.
