# Intent Audit

## Intent Inventory

Extracted from:

- Issue: `.conduct/issues/2026-02-12-x9k4m7p3-issue.md`
- User discussion (conversation context)

| #   | Intent Item                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------- |
| 1   | Drizzle adapter `resolveTable` must not throw for `__datafn_*` internal tables                            |
| 2   | Fix must work across ALL adapters (Drizzle, Prisma, Kysely, Memory), not just Drizzle                     |
| 3   | Adapter-level raw CRUD ("Path B") — a sub-interface that bypasses ORM schema resolution                   |
| 4   | `ensureTable` DDL for internal tables (lazy, cached, dialect-appropriate)                                 |
| 5   | Raw CRUD operations (`create`, `findOne`, `findMany`, `update`, `delete`) for internal tables             |
| 6   | Server routes internal table operations through new raw CRUD, not through user adapter CRUD               |
| 7   | `__datafn_meta` operations routed through raw CRUD                                                        |
| 8   | `__datafn_changes` operations routed through raw CRUD                                                     |
| 9   | `__datafn_idempotency` operations routed through raw CRUD                                                 |
| 10  | `__datafn_seed` operations routed through raw CRUD                                                        |
| 11  | Join tables — DataFn should use user-defined relation tables instead of `__datafn_join_*` internal tables |
| 12  | Add `joinTable` / `joinColumns` fields to `DatafnRelationSchema`                                          |
| 13  | Server resolves join table name from schema relation, uses normal adapter CRUD for named tables           |
| 14  | Fallback: unnamed join tables still work via `__datafn_join_*` through raw CRUD                           |
| 15  | DataFn CLI generates join table DDL in migrations when `joinTable` is set                                 |
| 16  | DataFn CLI codegen emits TS interfaces for join tables with metadata                                      |
| 17  | Users must NOT need to know about or register internal `__datafn_*` tables                                |
| 18  | Backward compatibility: existing schemas without `joinTable` continue to work                             |

## Coverage Mapping

| #   | Intent Item                  | SPEC.md Section                   | Requirement IDs                    | Test Vectors                           |
| --- | ---------------------------- | --------------------------------- | ---------------------------------- | -------------------------------------- |
| 1   | resolveTable fix             | Overview, Semantics               | DRZ-001                            | TV-DRZ-INTERNAL-001                    |
| 2   | All adapters                 | Goals, Invariants                 | DRZ-001, PRS-001, KYS-001, MEM-001 | TV-DRZ-_, TV-PRS-_, TV-KYS-_, TV-MEM-_ |
| 3   | Raw CRUD sub-interface       | Public API                        | ICRUD-001, ICRUD-002               | TV-ICRUD-001                           |
| 4   | ensureTable DDL              | Public API, Semantics             | ICRUD-003                          | TV-ENSURE-001, TV-ENSURE-002           |
| 5   | Raw CRUD ops                 | Public API                        | ICRUD-001                          | TV-DRZ-INTERNAL-001                    |
| 6   | Server routing               | Semantics (Routing)               | SRV-001–004                        | TV-SERVERSEQ-001                       |
| 7   | `__datafn_meta`              | Semantics, Data Formats           | SRV-001                            | TV-SERVERSEQ-001                       |
| 8   | `__datafn_changes`           | Semantics, Data Formats           | SRV-002                            | TV-CHANGELOG-001                       |
| 9   | `__datafn_idempotency`       | Semantics, Data Formats           | SRV-003                            | TV-IDEMP-001                           |
| 10  | `__datafn_seed`              | Semantics, Data Formats           | SRV-004                            | TV-SEED-001                            |
| 11  | Named join tables            | Semantics (Join Table Resolution) | JT-001, JT-002                     | TV-JT-RESOLVE-001                      |
| 12  | `joinTable`/`joinColumns`    | Public API (Modified Schema)      | JT-001                             | TV-JT-SCHEMA-001                       |
| 13  | Server join table resolution | Semantics                         | JT-002, JT-003                     | TV-JT-RESOLVE-001, TV-JT-COLS-001      |
| 14  | Fallback `__datafn_join_*`   | Semantics                         | JT-004                             | TV-JT-FALLBACK-001                     |
| 15  | CLI migration generation     | Public API (CLI)                  | CLI-001                            | TV-CLI-JT-001                          |
| 16  | CLI codegen interfaces       | Public API (CLI)                  | CLI-002                            | TV-CLI-CODEGEN-001                     |
| 17  | No user awareness needed     | Goals, Invariants                 | ICRUD-002                          | All internal CRUD vectors              |
| 18  | Backward compatibility       | Compatibility, Invariants         | JT-004                             | TV-JT-FALLBACK-001                     |

## Conclusion

**No missing intent items.** All 18 intent items extracted from the issue and user discussion are covered in SPEC.md with corresponding requirements and test vectors.
