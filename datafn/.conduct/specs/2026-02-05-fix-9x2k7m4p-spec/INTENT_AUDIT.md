## INTENT_AUDIT — CloneUp (offline user → cloud conversion)

### Intent Inventory (authoritative inputs → extracted intent)

Authoritative inputs read (see `SPEC.md` Metadata):
- `.conduct/audits/flux-to-datafn-migration-gap-analysis.md` (critical gap “Clone Up / Local-to-Cloud Upload”)
- `.conduct/intent/datafn.intent.md` (local-first + sync invariants)
- `.conduct/intent/spec.md` (schema-bounded + determinism)
- `.conduct/intent/implementation.md` and `.conduct/audits/sync-remote-audit-2026-01-25.md` (sync/remote realities)
- `.conduct/intent/2026-01-26-fixes/client-intent-1.md` (pushBatchSize/pushMaxRetries defaults)
- `server/README.md` (canonical `/datafn/*` envelopes)

Inventory items:

1. Add a first-class client API to upload an existing local dataset to the cloud on signup (`sync.cloneUp()`).
2. Validate prerequisites (storage configured, remote configured, schema available) and fail deterministically when missing.
3. Resolve upload scope deterministically; allow selecting a subset of resources; exclude remote-only resources from cloneUp scope.
4. Transform local records into schema-bounded DFQL record mutations using configurable `recordOperation`.
5. Upload many-many join rows (with metadata) by generating schema-bounded DFQL `relate` mutations from client join stores.
6. Deterministic + idempotent conversion: mutation IDs MUST be deterministic and safe for retries/re-runs; server dedupe uses `(clientId, mutationId)`.
7. Deterministic ordering: stable resource/record/join ordering and stage ordering (records before relations).
8. Push batching + retry policy: deterministic batching; retry only on transport errors; bounded by `maxRetries`.
9. Failure policy: server-side mutation errors must produce a safe failure (`ok=false`) without clearing changelog or advancing cursor; `failFast` controls continuation but not safety.
10. Post-conversion state: on success, monotonic cursor updates, changelog drain, and optional pullAfter catch-up to reach sync consistency.
11. Observability: emit `sync_applied` on success and `sync_failed` on failure with `context.phase="cloneup"`, without leaking record payloads.
12. Compatibility: MUST work with existing `/datafn/push` (TS + Python servers); no new server endpoints required.
13. Explicit non-goals: no product UX for multi-device merge conflicts; no local DB guest→user migration; no automatic signup detection (host triggers cloneUp).

---

### Coverage audit (intent → spec/requirements/tests)

#### 1) First-class client API `sync.cloneUp()`
- **SPEC.md**: Overview; Public API
- **Requirements**: `CLONEUP-API-001`
- **Test vectors**: `TV-CLONEUP-001`

#### 2) Prerequisite validation (storage/remote/schema)
- **SPEC.md**: Semantics → Validate prerequisites; Error codes (client-side)
- **Requirements**: `CLONEUP-API-002`
- **Test vectors**: `TV-CLONEUP-003`, `TV-CLONEUP-004`

#### 3) Deterministic scope + remote-only exclusion
- **SPEC.md**: Semantics → Resolve upload scope; Error codes (client-side)
- **Requirements**: `CLONEUP-SCOPE-001`
- **Test vectors**: `TV-CLONEUP-002`, `TV-CLONEUP-005`

#### 4) Record mutation generation (schema-bounded, configurable operation)
- **SPEC.md**: Semantics → Stage A; Data formats/protocol (mutation envelope)
- **Requirements**: `CLONEUP-MUT-001`
- **Test vectors**: `TV-CLONEUP-001`, `TV-CLONEUP-008`, `TV-CLONEUP-010`

#### 5) Many-many join upload (relate + metadata)
- **SPEC.md**: Semantics → Stage B; Glossary (join store/row)
- **Requirements**: `CLONEUP-JOIN-001`, `CLONEUP-MUT-002`
- **Test vectors**: `TV-CLONEUP-001`, `TV-CLONEUP-007`, `TV-CLONEUP-009`

#### 6) Deterministic + idempotent mutationId generation
- **SPEC.md**: Data formats/protocol → Deterministic mutationId generation; Invariants (Idempotency, Determinism)
- **Requirements**: `CLONEUP-MUT-001`, `CLONEUP-MUT-002`
- **Test vectors**: `TV-CLONEUP-001`, `TV-CLONEUP-010`

#### 7) Deterministic ordering + stage ordering
- **SPEC.md**: Semantics → Stage A/Stage B sorting; Invariants (Ordering)
- **Requirements**: `CLONEUP-ORDER-001`
- **Test vectors**: `TV-CLONEUP-001`, `TV-CLONEUP-010`

#### 8) Push batching + transport-only retries
- **SPEC.md**: Semantics (push batching per resource/join store); Retry policy; Error codes
- **Requirements**: `CLONEUP-PUSH-001`
- **Test vectors**: `TV-CLONEUP-011`, `TV-CLONEUP-013`

#### 9) Failure policy (server errors → ok=false; no local state changes)
- **SPEC.md**: Failure policy; Invariants; Semantics → Finalize local sync state
- **Requirements**: `CLONEUP-PUSH-002`, `CLONEUP-STATE-002`
- **Test vectors**: `TV-CLONEUP-012`

#### 10) Post-conversion state (cursor/changelog/pullAfter)
- **SPEC.md**: Semantics → Finalize local sync state; Limits/caps
- **Requirements**: `CLONEUP-STATE-001`
- **Test vectors**: `TV-CLONEUP-001`, `TV-CLONEUP-006`

#### 11) Observability events (sync_applied / sync_failed)
- **SPEC.md**: Observability; Security (no payload leakage)
- **Requirements**: `CLONEUP-EVT-001`
- **Test vectors**: `TV-CLONEUP-006`, `TV-CLONEUP-012`

#### 12) Compatibility with existing servers and `/datafn/push`
- **SPEC.md**: Server API; Data formats/protocol; Compatibility / versioning strategy
- **Requirements**: `CLONEUP-COMPAT-001`
- **Test vectors**: `TV-CLONEUP-001`, `TV-CLONEUP-010`, `TV-CLONEUP-014`

#### 13) Explicit non-goals
- **SPEC.md**: Non-goals; Server API; Undefined / Explicitly user-deferred only
- **Requirements**: N/A (non-goals are constraints on scope, not deliverables)
- **Test vectors**: N/A

---

### Final audit result

**No missing intent items.**

