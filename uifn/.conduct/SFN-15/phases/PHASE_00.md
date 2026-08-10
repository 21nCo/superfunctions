# PHASE_00: Baseline Audit and Contract Lock

## Phase Goal

Create an implementation baseline that inventories current `uifn`, locks the Coss capability snapshot, and identifies code to keep, rewrite, or delete.

## In Scope

- Current package/export inventory.
- Current primitive and adapter inventory.
- Current test and release-gate inventory.
- Coss target catalog lock.
- Clean-room policy file.

## Out of Scope

- Code rewrites.
- New public APIs.

## Deliverables

- `uifn/.conduct/SFN-15/phase-reports/PHASE_00_BASELINE.md`
- `uifn/.conduct/SFN-15/data/current-package-inventory.json`
- `uifn/.conduct/SFN-15/data/coss-catalog-snapshot.json`
- `uifn/.conduct/SFN-15/data/delete-or-rewrite-inventory.json`

## Requirements Covered

ARCH-001, ARCH-002, COMP-001, VER-001

## Implementation Tasks

1. List all current `uifn/*/package.json` packages and export maps.
2. List current core primitives and framework adapter exports.
3. List current tests by package and primitive.
4. Save the Coss catalog snapshot from `COMPONENT_CATALOG.md` as JSON.
5. Mark each current API as keep, rewrite, delete, or undefined.
6. Write a clean-room implementation policy note.

## Verification Steps

```bash
find uifn -maxdepth 3 -name package.json | sort
rg -n "export \\*" uifn/core/src uifn/react/src uifn/svelte/src uifn/vue/src
```

Expected outcome: the phase report contains a complete current-state inventory and no implementation changes.

## Stop Condition

Report the inventory summary and any current APIs that conflict with SFN-15.

