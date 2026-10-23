# INTENT AUDIT: Lifecycle-Aware Signals

## Intent Inventory

The following intent items were extracted from:
- The user's request for "Option C" — making DatafnSignal itself lifecycle-aware so signals auto-recreate on client switch, eliminating all wrapper boilerplate.
- Issue `2026-02-23-m3k7xv9p-issue.md` (superseded — relevant fixes absorbed).
- Conversation context tracing back to the original observation of boilerplate in `App.svelte`.

### Inventory

| # | Intent Item | Source |
|---|---|---|
| 1 | Signals created via `client.table(name).signal(query)` must survive `switchContext()` without any external wrapper | User request (Option C) |
| 2 | Signals created via `client[name].signal(query)` (dynamic accessor) must also survive switches | User request (Option C) |
| 3 | KV signals (`client.kv.signal(key)`) must also survive switches | Implied by Option C (KV is a signal source) |
| 4 | The signal must implement the full `DatafnSignal<T>` interface (get, subscribe, loading, error, refreshing, dispose) | Implicit — must be a drop-in replacement |
| 5 | Svelte's `$` prefix must work directly with the signal (Svelte store contract) | User request — "no wrapper at all" |
| 6 | Existing subscribers must receive new data after a switch without re-subscribing | Core value proposition of Option C |
| 7 | Signal deduplication — same query returns same signal instance | Existing behavior of `SignalRegistry` — must be preserved |
| 8 | Signal disposal must clean up lifecycle subscriptions | Memory leak prevention |
| 9 | `defineSchema()` must preserve literal resource names in return type | Issue m3k7xv9p Fix 3 (absorbed) |
| 10 | `ResourceNames<typeof schema>` must resolve to literal union, not `string` | Issue m3k7xv9p Fix 3 (absorbed) |
| 11 | Todo app client schema must use `defineSchema` without explicit `: DatafnSchema` annotation | Issue m3k7xv9p Fix 4 (absorbed) |
| 12 | Todo app must have zero `(c as any)` casts for signal/table access | Issue m3k7xv9p Fix 5 (absorbed — different approach) |
| 13 | `clientRef` boilerplate must be eliminated from the todo app | User observation — "this boilerplate" |
| 14 | `createSwitchableClient` must have proper JSDoc `@deprecated` tags | Issue m3k7xv9p Fix 6 (absorbed) |
| 15 | `SwitchableClient` and `SwitchableClientConfig` must have JSDoc `@deprecated` tags | Issue m3k7xv9p Fix 6 (absorbed) |
| 16 | `toSvelteStore` should accept a signal directly (not only a factory) | Implied by Option C — signals are lifecycle-aware, so factory pattern is unnecessary |
| 17 | Factory-based `toSvelteStore(clientRef, factory)` must remain backward-compatible | Backward compat requirement |
| 18 | Factory-based `toSvelteStore` and `ClientRef` should be deprecated | Deprecation of superseded API |
| 19 | No infinite recursion from Proxy intercepting `.signal()` calls | Implementation correctness |
| 20 | Non-signal table methods (query, mutate, transact) must not be affected by wrapping | Implementation correctness |
| 21 | Error during rebind (factory throws) must be caught, not crash the app | Robustness |
| 22 | `client.destroy()` must clean up all LiveSignals | Resource cleanup |
| 23 | Existing explicit `const s: DatafnSchema = defineSchema(...)` must still compile | Backward compat for defineSchema |

## Coverage Mapping

| # | Intent Item | SPEC.md Section | Requirements | Test Vectors |
|---|---|---|---|---|
| 1 | Table signals survive switchContext | Architecture → LiveSignal lifecycle; Semantics → Signal survival | SIG-LIVE-002, PROXY-001 | TV-LIVE-003, TV-PROXY-001 |
| 2 | Dynamic accessor signals survive switchContext | Architecture → Proxy table/KV wrapping | PROXY-002 | TV-PROXY-001 |
| 3 | KV signals survive switchContext | Architecture → Proxy table/KV wrapping | PROXY-003 | TV-PROXY-002 |
| 4 | Full DatafnSignal<T> interface | Public API → LiveSignal; Glossary → LiveSignal | SIG-LIVE-001 | TV-LIVE-001 |
| 5 | Svelte store contract (`$` prefix) | Semantics → Svelte store contract compatibility | SIG-LIVE-007 | TV-LIVE-001 |
| 6 | Subscribers receive new data after switch | Semantics → Signal survival across switchContext | SIG-LIVE-003 | TV-LIVE-003 |
| 7 | Signal deduplication | Semantics → Signal deduplication; Architecture → LiveSignalRegistry | REG-001 | TV-REG-001 |
| 8 | Disposal cleanup | Semantics → Signal disposal | SIG-LIVE-005, SIG-LIVE-006 | TV-LIVE-005, TV-LIVE-006 |
| 9 | defineSchema preserves literal names | Public API → Changed: defineSchema; Semantics → defineSchema type preservation | TYPE-001 | TV-TYPE-001 |
| 10 | ResourceNames resolves to literal union | Public API → Changed: defineSchema; Semantics → defineSchema type preservation | TYPE-002 | TV-TYPE-001, TV-TYPE-002 |
| 11 | Todo app uses defineSchema without annotation | Non-Goals (n/a); covered by APP-001 | APP-001 | TV-APP-001 |
| 12 | Zero (c as any) casts in todo app | Goals #1; covered by APP-003 | APP-003 | TV-APP-001 |
| 13 | No clientRef boilerplate | Goals #1; covered by APP-004 | APP-004 | TV-APP-001 |
| 14 | createSwitchableClient @deprecated | Public API → Deprecated: createSwitchableClient | DEPR-001 | N/A (JSDoc only) |
| 15 | SwitchableClient/Config @deprecated | Public API → Deprecated: createSwitchableClient | DEPR-002 | N/A (JSDoc only) |
| 16 | toSvelteStore accepts signal directly | Public API → Changed: toSvelteStore | SVELTE-001 | TV-SVELTE-001 |
| 17 | Factory overload backward compat | Compatibility / versioning strategy | SVELTE-002 | TV-SVELTE-002 |
| 18 | Factory overload + ClientRef deprecated | Public API → Deprecated: ClientRef | SVELTE-002, SVELTE-003 | TV-SVELTE-002 |
| 19 | No infinite recursion | Invariants #8 | PROXY-004 | TV-PROXY-003 |
| 20 | Non-signal table methods unaffected | Invariants #1 (Proxy transparency) | PROXY-005 | TV-PROXY-004 |
| 21 | Error during rebind caught | Observability | SIG-LIVE-008 | TV-LIVE-007 |
| 22 | client.destroy() cleans up LiveSignals | Semantics → Client destruction | PROXY-007, REG-003 | TV-LIVE-008 |
| 23 | Explicit DatafnSchema annotation compiles | Semantics → defineSchema type preservation | TYPE-003 | TV-TYPE-003 |

## Missing Intent Items

**No missing intent items.** All 23 intent items are fully covered across SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md, and the phased PLAN.

## Superseded Issue Mapping

Issue `2026-02-23-m3k7xv9p-issue.md` proposed 6 fixes. Mapping to this spec:

| Fix # | Description | Status in This Spec |
|---|---|---|
| Fix 1 | `toSvelteStore` overload accepting `subscribeClient` | **SUPERSEDED** — LiveSignals eliminate the need. SVELTE-001 provides a better overload (signal directly). |
| Fix 2 | Remove `C = any` default from `toSvelteStore` | **SUPERSEDED** — The new direct overload has no `C` generic. Factory overload is deprecated. |
| Fix 3 | `defineSchema` return type preserving literal names | **ABSORBED** → TYPE-001, TYPE-002 in Phase 0. |
| Fix 4 | Migrate todo app to `defineSchema` | **ABSORBED** → APP-001 in Phase 4. |
| Fix 5 | Remove `(c as any)` casts from App.svelte | **ABSORBED** → APP-003 in Phase 4 (different approach — no factory at all). |
| Fix 6 | JSDoc `@deprecated` on createSwitchableClient | **ABSORBED** → DEPR-001, DEPR-002 in Phase 0. |
