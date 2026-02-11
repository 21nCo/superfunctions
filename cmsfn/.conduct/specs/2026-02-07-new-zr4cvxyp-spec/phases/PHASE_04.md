# PHASE_04: Document lists (CFQL-powered panes)

## Phase goal

Implement document list panes that query ContentFn via CFQL deterministically, including pagination and error surfacing.

## In scope

- Studio list pane UI for desk nodes of kind `documentList`.
- ContentFn client integration (HTTP) for CFQL queries.
- Deterministic ordering behavior (explicit orderBy or ContentFn default).
- Cursor pagination handling as opaque values.
- Deterministic error state when ContentFn query fails.

## Out of scope

- Document editor (PHASE_05)
- Reference expansion and picker (PHASE_09)

## Deliverables

- `cmsfn/studio/src/panes/list/DocumentListPane.tsx`
- `cmsfn/studio/src/contentfn/client.ts` (typed client wrapper)
- `cmsfn/studio/src/panes/list/useCfqlQuery.ts`
- `cmsfn/studio/src/panes/list/ListErrorState.tsx`
- Tests implementing:
  - TV-LIST-QUERY-001
  - TV-LIST-PAGINATION-001
  - TV-LIST-QUERY-002

## Requirements covered

- DOC-001
- STUDIO-002 (dataset scoping; continued)

## Implementation tasks

1. Map desk node to a CFQL query:
   - dataset from selector
   - types from desk node
   - orderBy from node defaultOrder (if provided)
2. Implement paging:
   - store `nextCursor` from ContentFn
   - request next page using cursor without parsing/mutation
3. Implement deterministic error surfacing:
   - display error summary + retry action
4. Add tests verifying network calls contain correct dataset/types and cursor opacity.

## Verification steps

- Run list pane tests; confirm repeated loads yield the same ordering for unchanged backend state.

## Stop condition

- List panes are functional, deterministic, and pass referenced TVs.

