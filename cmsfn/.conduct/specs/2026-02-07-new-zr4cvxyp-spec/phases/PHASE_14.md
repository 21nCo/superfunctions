# PHASE_14: Extensibility + collaboration polish

## Phase goal

Provide deterministic extension points for custom field widgets and desk panes, and finalize multi-session live update behavior driven by realtime events.

## In scope

- Field widget extension interface:
  - register custom widget per field or field type
  - deterministic conflict resolution
- Desk custom panes:
  - register custom panes and route them deterministically
- Collaboration polish:
  - update lists on publish events
  - show remote-changed banner in editors

## Out of scope

- True multi-cursor collaborative richtext editing (undefined unless explicitly required)

## Deliverables

- `cmsfn/core/src/plugins/registry.ts`
- `cmsfn/studio/src/plugins/registerWidget.ts`
- `cmsfn/studio/src/desk/registerPane.ts`
- `cmsfn/studio/src/realtime/applyEvents.ts`
- Tests implementing:
  - TV-PLUG-001
  - TV-PLUG-002
  - TV-COLLAB-001
  - TV-COLLAB-002

## Requirements covered

- PLUG-001
- DESK-001 (extension mechanism; complements PHASE_12 panes)
- COLLAB-001

## Implementation tasks

1. Implement plugin registry with deterministic ordering:
   - document precedence rule (first/last wins)
2. Allow registering widget overrides and apply them during editor render.
3. Add desk pane registration and ensure deterministic routing and keys.
4. Subscribe to realtime events globally and update:
   - list panes
   - open editors (remote-changed banner)
5. Add tests for deterministic plugin resolution and live update UI behaviors.

## Verification steps

- Run plugin and collab tests.
- Manual smoke: open two sessions and verify updates.

## Stop condition

- Extensibility and collaboration behaviors are deterministic and pass referenced TVs.

