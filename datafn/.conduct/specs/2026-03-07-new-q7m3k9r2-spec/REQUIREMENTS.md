# REQUIREMENTS

## Table Of Contents
- [RCAP-001](#rcap-001) Relation capability schema type
- [RCAP-002](#rcap-002) Relation capability validation scope and values
- [RCAP-003](#rcap-003) Relation metadata collision detection
- [RCAP-004](#rcap-004) Deterministic relation capability resolution
- [JCG-001](#jcg-001) Drizzle join-table capability column generation
- [JCG-002](#jcg-002) Type codegen for relation-capability join rows
- [JRT-001](#jrt-001) Readonly relation-capability field stripping
- [JRT-002](#jrt-002) Relate create-path relation-capability injection
- [JRT-003](#jrt-003) Relate update-path relation-capability injection
- [JRT-004](#jrt-004) modifyRelation relation-capability behavior
- [JSY-001](#jsy-001) Push path parity for relation-capability injection
- [JSY-002](#jsy-002) Change-tracking and pull/clone parity for relation capability fields
- [SEC-001](#sec-001) Actor and namespace security boundaries for relation capability fields
- [COMP-001](#comp-001) Backward compatibility for non-opt-in schemas
- [OBS-001](#obs-001) Observability for relation capability processing

---

### RCAP-001
- **ID**: RCAP-001
- **Priority**: P0
- **Statement**: `DatafnRelationSchema` MUST support an optional `capabilities` array limited to relation capability entries.
- **Rationale**: Join-table capability behavior must be explicit and schema-driven.
- **Acceptance criteria**:
  - `relations[].capabilities` is accepted by `defineSchema()` and `validateSchema()`.
  - Omitted `relations[].capabilities` preserves current behavior.
  - Type definitions compile for relation capability declarations.
- **Test vectors**: TV-RCAP-001
- **Notes**: This requirement introduces relation-level API surface only; no default inheritance is implied.

### RCAP-002
- **ID**: RCAP-002
- **Priority**: P0
- **Statement**: Relation capability validation MUST allow only `timestamps` and `audit` and MUST reject relation capability usage on non-`many-many` relation types.
- **Rationale**: Keeps semantics well-defined and avoids unsupported lifecycle modes.
- **Acceptance criteria**:
  - `many-many` with `capabilities: ["timestamps"]` validates.
  - `many-many` with `capabilities: ["audit"]` validates.
  - Unknown capability values fail with deterministic validation error.
  - `one-many`, `many-one`, or `htree` with relation capabilities fail validation.
- **Test vectors**: TV-RCAP-002
- **Notes**: Error code mapping is defined in SPEC error-code section.

### RCAP-003
- **ID**: RCAP-003
- **Priority**: P0
- **Statement**: Schema validation MUST reject relation metadata fields that collide with relation capability field names.
- **Rationale**: Prevents ambiguity between user metadata and server-managed relation fields.
- **Acceptance criteria**:
  - `metadata` field `createdAt` with `timestamps` enabled returns `CAPABILITY_FIELD_COLLISION`.
  - `metadata` field `updatedBy` with `audit` enabled returns `CAPABILITY_FIELD_COLLISION`.
  - Non-colliding metadata fields validate.
- **Test vectors**: TV-RCAP-003
- **Notes**: Collision checks apply per relation definition.

### RCAP-004
- **ID**: RCAP-004
- **Priority**: P0
- **Statement**: Relation capability resolution MUST be deterministic and MUST return canonical order `timestamps`, then `audit` when both are enabled.
- **Rationale**: Determinism is required for stable codegen and predictable execution behavior.
- **Acceptance criteria**:
  - Repeated validation of identical schema yields identical resolved relation capability order.
  - Duplicate entries are deduplicated.
  - Mixed input ordering yields canonical output ordering.
- **Test vectors**: TV-RCAP-004
- **Notes**: Canonical ordering is internal behavior; external API remains array-based.

### JCG-001
- **ID**: JCG-001
- **Priority**: P0
- **Statement**: Drizzle codegen MUST generate relation capability columns on many-many join tables when relation capabilities are enabled.
- **Rationale**: DB schema must match runtime-written capability fields.
- **Acceptance criteria**:
  - Join table with `timestamps` includes `createdAt` and `updatedAt` columns with correct SQL type mapping.
  - Join table with `audit` includes `createdBy` and `updatedBy` columns with correct SQL type mapping.
  - Join table with both includes all four columns.
  - Join tables without relation capabilities remain unchanged.
- **Test vectors**: TV-JCG-001
- **Notes**: Existing namespace/index/PK behavior remains intact.

### JCG-002
- **ID**: JCG-002
- **Priority**: P1
- **Statement**: Type codegen MUST include relation capability fields in generated join-table interfaces and MUST emit join-table interfaces when capabilities are enabled even if metadata is empty.
- **Rationale**: Typed clients must see persisted join-row shape.
- **Acceptance criteria**:
  - Generated join interface includes relation metadata + relation capability fields.
  - Relation with capability-only (no metadata) still produces join interface.
  - Relations without metadata and without capabilities do not produce extra join interfaces.
- **Test vectors**: TV-JCG-002
- **Notes**: Resource interfaces are unchanged by this requirement.

### JRT-001
- **ID**: JRT-001
- **Priority**: P0
- **Statement**: Server relation mutation execution MUST strip readonly relation capability fields from client-provided relation metadata before persistence.
- **Rationale**: Prevents forged server-managed join-row audit/timestamp values.
- **Acceptance criteria**:
  - Client-sent `createdAt/updatedAt/createdBy/updatedBy` are removed before write.
  - Stripping is applied only for capabilities enabled on that relation.
  - Non-capability metadata keys are preserved.
- **Test vectors**: TV-JRT-001
- **Notes**: Applies to both `relate` and `modifyRelation`.

### JRT-002
- **ID**: JRT-002
- **Priority**: P0
- **Statement**: `relate` create-path writes MUST inject insert-time relation capability fields for enabled relation capabilities.
- **Rationale**: New join rows require complete capability state on first persist.
- **Acceptance criteria**:
  - First relate for a pair sets `createdAt` and `updatedAt` when `timestamps` enabled.
  - First relate sets `createdBy` and `updatedBy` when `audit` enabled.
  - When capabilities are disabled, these fields are not injected.
- **Test vectors**: TV-JRT-002
- **Notes**: `createdAt`/`createdBy` are immutable after first create.

### JRT-003
- **ID**: JRT-003
- **Priority**: P0
- **Statement**: `relate` upsert update-path writes MUST inject update-time relation capability fields and MUST preserve immutable insert-time fields.
- **Rationale**: Idempotent re-relate and metadata updates must keep consistent audit semantics.
- **Acceptance criteria**:
  - Re-relating existing pair updates `updatedAt` and `updatedBy` when enabled.
  - Existing `createdAt` and `createdBy` are not overwritten.
  - Update path without enabled capabilities preserves current behavior.
- **Test vectors**: TV-JRT-003
- **Notes**: Applies regardless of metadata payload presence.

### JRT-004
- **ID**: JRT-004
- **Priority**: P0
- **Statement**: `modifyRelation` MUST inject update-time relation capability fields for existing rows and MUST return `NOT_FOUND` without writing when the relation row does not exist.
- **Rationale**: `modifyRelation` is update-only and must preserve current existence contract.
- **Acceptance criteria**:
  - Existing relation row receives metadata update + `updatedAt`/`updatedBy` when enabled.
  - Missing relation row returns deterministic `NOT_FOUND` error.
  - No create fallback occurs in `modifyRelation`.
- **Test vectors**: TV-JRT-004
- **Notes**: Transactional behavior remains unchanged.

### JSY-001
- **ID**: JSY-001
- **Priority**: P0
- **Statement**: Push-executed relation mutations MUST use the same relation capability stripping and injection semantics as direct mutation execution.
- **Rationale**: Online and sync mutation paths must remain behaviorally equivalent.
- **Acceptance criteria**:
  - `/datafn/push` relate on capability-enabled relation writes injected fields.
  - Push payload readonly relation capability fields are stripped.
  - Capability-disabled relations do not receive injected fields via push.
- **Test vectors**: TV-JSY-001
- **Notes**: Applies to mixed mutation batches.

### JSY-002
- **ID**: JSY-002
- **Priority**: P0
- **Statement**: Join-row change-tracking, pull, and clone outputs MUST include relation capability fields when present on stored join rows.
- **Rationale**: Clients require full deterministic edge state for convergence.
- **Acceptance criteria**:
  - Change entries for join rows include injected capability fields.
  - Pull and clone responses include persisted capability fields on join rows.
  - Non-enabled relations produce unchanged join-row payloads.
- **Test vectors**: TV-JSY-002
- **Notes**: No new sync envelope shape is introduced.

### SEC-001
- **ID**: SEC-001
- **Priority**: P0
- **Statement**: Relation capability audit fields MUST be sourced only from server actor context and namespace-isolated writes MUST remain unchanged.
- **Rationale**: Prevent privilege escalation and tenant boundary leakage.
- **Acceptance criteria**:
  - `createdBy/updatedBy` come from `actorId` or `null` fallback only.
  - Client-provided actor-like metadata does not override audit fields.
  - Namespace wrapping behavior on join rows remains valid.
- **Test vectors**: TV-SEC-001
- **Notes**: This requirement does not alter namespace provider API.

### COMP-001
- **ID**: COMP-001
- **Priority**: P0
- **Statement**: Schemas without `relations[].capabilities` MUST preserve existing codegen and runtime behavior exactly.
- **Rationale**: Existing deployments must not change behavior without explicit opt-in.
- **Acceptance criteria**:
  - Generated join-table definitions are unchanged for relations without capabilities.
  - Existing relate/modify/unrelate behavior remains unchanged where capabilities are not configured.
  - Existing tests for non-capability relation flows continue passing.
- **Test vectors**: TV-COMP-001
- **Notes**: Migration is opt-in per relation.

### OBS-001
- **ID**: OBS-001
- **Priority**: P2
- **Statement**: Server logging SHOULD include debug traces for relation capability resolution and stripping/injection decisions without exposing sensitive auth context.
- **Rationale**: Easier diagnosis with bounded log exposure.
- **Acceptance criteria**:
  - Debug logs indicate relation capability resolution result.
  - Debug logs indicate stripped readonly fields and injected field set.
  - Logs do not include bearer tokens or complete auth objects.
- **Test vectors**: TV-OBS-001
- **Notes**: Logging verbosity remains controlled by existing logger config.
