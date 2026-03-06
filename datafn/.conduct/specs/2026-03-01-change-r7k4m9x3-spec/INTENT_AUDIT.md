# INTENT AUDIT

## Intent Inventory

Extracted from user conversation and discussion:

1. **Replace `tenantId`/`userId` labels** with generic namespace terminology — the current labels assume SaaS multi-tenancy, but use cases vary (personal workspaces, teams, projects, IoT, etc.)
2. **Single composable `namespace: string`** as the isolation primitive — not a two-level `space`/`subSpace`, but a single string the user composes freely
3. **`ns()` helper function** for constructing colon-delimited namespace strings from N segments
4. **Support N levels** (not just 2) — personal user with workspaces, org with project and user, etc.
5. **Decouple datafn from `@superfunctions/auth`'s `AuthContext`** — datafn should not import auth types for namespace purposes
6. **Rename `multiTenant` to a generic term** — remove SaaS connotation from schema config
7. **authfn integration** — the new approach must work cleanly with a full-featured auth system (not just API keys), where the user manually bridges auth session → namespace
8. **Separate audit attribution from namespace isolation** — who did it (actorId) vs. where it's stored (namespace)
9. **Backward compatibility** — existing deployments must not break; legacy API must produce identical `__ns` values
10. **Client-side changes** — namespace config, storage factory, switchContext, cross-tab, sync engine all need updating
11. **`DatafnStorageFactory` signature** — should accept `namespace: string` instead of `AuthContext`
12. **`IndexedDbStorageAdapter` factory** — new `createForNamespace()` method
13. **`currentNamespace()` method** — replace `currentContext()` on client
14. **CLI codegen** — must respect the renamed schema field
15. **No modification to `@superfunctions/auth`** — auth package keeps its own `AuthContext` type; datafn just stops using it for namespace purposes

## Coverage Audit

| # | Intent Item | SPEC.md Section | Requirements | Test Vectors |
|---|---|---|---|---|
| 1 | Replace tenant/user labels | Overview, Public API | NS-002, NS-003, NS-007 | TV-NS-004–006, TV-NS-007, TV-NS-016 |
| 2 | Single composable namespace string | Overview, Public API (server + client) | NS-003, NS-004, NS-007 | TV-NS-007, TV-NS-009, TV-NS-016 |
| 3 | `ns()` helper function | Public API (@datafn/core) | NS-001 | TV-NS-001, TV-NS-002, TV-NS-003 |
| 4 | Support N levels | Public API (`ns()` accepts variadic args) | NS-001 | TV-NS-001 (two segments), TV-NS-003 (empty filtering implies N segments work) |
| 5 | Decouple from AuthContext | Overview, Public API, Non-goals | NS-003, NS-007, NS-020 | TV-NS-007, TV-NS-016 |
| 6 | Rename multiTenant | Public API (@datafn/core), Glossary | NS-002, NS-017 | TV-NS-004, TV-NS-005, TV-NS-006, TV-NS-032 |
| 7 | authfn integration | Compatibility section, migration examples | NS-003, NS-005 | TV-NS-007, TV-NS-012, TV-NS-013 |
| 8 | Separate actorId from namespace | Public API (server + client), Glossary | NS-014, NS-015 | TV-NS-027, TV-NS-028, TV-NS-029 |
| 9 | Backward compatibility | Compatibility section, Invariants INV-003 | NS-005, NS-007, NS-008 | TV-NS-012, TV-NS-013, TV-NS-014, TV-NS-019, TV-NS-024 |
| 10 | Client-side changes | Public API (@datafn/client) — full subsection | NS-007–013, NS-019–020, NS-022–023 | TV-NS-016–026, TV-NS-034–035, TV-NS-038, TV-NS-040 |
| 11 | StorageFactory signature | Public API, Data Formats | NS-008, NS-019 | TV-NS-018, TV-NS-019, TV-NS-034, TV-NS-035 |
| 12 | IndexedDb createForNamespace | Public API | NS-009 | TV-NS-020, TV-NS-021 |
| 13 | currentNamespace() | Public API | NS-012 | TV-NS-025 |
| 14 | CLI codegen | Public API (@datafn/cli) | NS-016 | TV-NS-030, TV-NS-031 |
| 15 | No auth package modification | Non-goals | N/A (constraint) | N/A |

## Missing Intent Items

**No missing intent items.** All 15 intent items are covered by the spec, requirements, and test vectors.

## Notes

- Intent item 7 (authfn integration) is addressed architecturally — the `namespaceProvider.getNamespace(ctx)` pattern cleanly bridges any auth system (API keys, OAuth, sessions, etc.) without datafn needing to know auth internals.
- Intent item 4 (N levels) is naturally handled by `ns()` accepting variadic arguments — no artificial cap at 2 levels.
- Intent item 15 is a constraint (non-goal), verified by absence of changes to `packages/auth/`.
