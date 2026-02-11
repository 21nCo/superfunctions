# CmsFn Implementation Plan

## Architecture sketch

Recommended package layout (aligned with Superfunctions patterns):

```
superfunctions/
  cmsfn/
    .conduct/...
    studio/                 # package: @cmsfn/studio (web UI)
    server/                 # package: @cmsfn/server (sessions/roles/releases/preview tokens)
    core/                   # package: @cmsfn/core (shared types, desk model, permissions)
    plugins/                # optional extension packages
    examples/
      next-studio/
      preview-target/
```

Responsibilities:

- `@cmsfn/core`
  - canonical error/envelope types
  - role model + permission evaluation (pure/deterministic)
  - desk node model + deterministic node keys
  - workflow and release models
- `@cmsfn/server`
  - endpoints defined in `SPEC.md`
  - auth integration (authfn recommended)
  - role CRUD storage and enforcement
  - preview token minting and validation logic
  - release orchestration calling ContentFn publish/unpublish
  - audit endpoints that expose ContentFn metadata safely
  - ContentFn capability checks and health/status
- `@cmsfn/studio`
  - desk UI + panes (lists/editor/preview/media/audit)
  - schema-driven editor rendering
  - reference picker + media library UX
  - conflict handling UI for `REV_CONFLICT`
  - realtime subscriptions to update lists and previews
  - built using `@uifn/*` primitives for dialogs, combobox, panels, etc.

## Dependency graph

- PHASE_00 scaffolds core types + permission evaluation + minimal server wiring.
- PHASE_01 builds `/cmsfn/status` and ContentFn health/capability checks.
- PHASE_02 implements roles model + storage + enforcement (ROLE-001, ENV-001).
- PHASE_03 implements desk model and Studio boot/navigation (STUDIO-001, STUDIO-002).
- PHASE_04 implements document lists (DOC-001) and dataset scoping enforcement.
- PHASE_05 implements schema-driven editor rendering and patch saves (SCHEMA-001/002, DOC-002).
- PHASE_06 implements workflow UX + gating and publish/unpublish actions (DOC-003, WF-001).
- PHASE_07 implements preview tokens + live preview updates (PREVIEW-001, COLLAB-001).
- PHASE_08 implements media library and asset insertion (MEDIA-001).
- PHASE_09 implements reference picker UX (REF-001).
- PHASE_10 implements releases (REL-001).
- PHASE_11 implements ops import/export triggers (OPS-001).
- PHASE_12 implements audit viewer endpoints and panes (AUDIT-001).
- PHASE_13 implements observability + limits hardening (OBS-001, LIMIT-001).
- PHASE_14 implements plugin/widget extension surface (PLUG-001) and desk custom panes (DESK-001).

## Phases overview

| Phase | Goal | Delivered capability | Verification |
|------:|------|----------------------|--------------|
| 00 | Core scaffolding | core types, permission evaluator, desk model types | unit tests |
| 01 | Status + health | `/cmsfn/status`, ContentFn capability checks | TV-STATUS-* |
| 02 | Roles + enforcement | role CRUD + deny paths | TV-ROLE-*, TV-ENV-* |
| 03 | Studio boot + desk | deterministic desk UI, dataset selector | TV-STUDIO-*, TV-DESK-*, TV-DATASET-* |
| 04 | Lists | document list panes via CFQL | TV-LIST-* |
| 05 | Editor | schema widgets + save + conflict UI | TV-EDITOR-* |
| 06 | Workflow + publish | draft/publish UX + gating | TV-WORKFLOW-*, TV-WF-* |
| 07 | Preview | tokens + live updates | TV-PREVIEW-* |
| 08 | Media | upload/browse/insert asset refs | TV-MEDIA-* |
| 09 | References | reference picker | TV-REF-PICKER-* |
| 10 | Releases | create/add/publish releases | TV-REL-* |
| 11 | Ops | trigger ContentFn import/export | TV-OPS-* |
| 12 | Audit | audit endpoints + panes | TV-AUDIT-* |
| 13 | Hardening | logs redaction + limits | TV-OBS-*, TV-LIMIT-* |
| 14 | Extensibility | widget extensions + desk panes | TV-PLUG-*, TV-DESK-PANES-*, TV-COLLAB-* |

## Definition of Done (global)

No phase is complete unless:
1. Deliverables are implemented.
2. All phase verification vectors pass deterministically.
3. Permission enforcement is validated via negative vectors.
4. The Studio remains usable end-to-end: list → edit draft → preview → publish → audit.

