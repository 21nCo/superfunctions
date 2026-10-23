## Phase goal

Add a schema-driven date codec so Nucleus receives Date objects and mutations serialize Date values deterministically.

## In scope

- Outbound mutation serialization: `Date` → ISO 8601 string (UTC).
- Inbound query result parsing: ISO string → `Date` for schema `date` fields.
- Deterministic error behavior for invalid date values.
- Tests for codec behavior.

## Out of scope

- Encryption codecs (not required by identified gaps).

## Deliverables

- Add:
  - `datafn/client/src/codecs/date.ts` (new)
- Modify:
  - `datafn/client/src/query.ts` (apply inbound codec)
  - `datafn/client/src/mutate.ts` (apply outbound codec)
  - `datafn/client/src/index.ts` (export codec hooks if public)
- Add/modify tests:
  - `datafn/client/__tests__/query.test.ts`
  - `datafn/client/__tests__/mutate.test.ts`

## Requirements covered

- CODEC-001

## Implementation tasks

- [ ] Implement schema inspection for date fields:
  - determine which fields in a resource are type `date`
  - handle nested objects as Undefined unless explicitly supported
- [ ] Outbound codec:
  - for any `record[field]` that is `Date`, convert to `toISOString()`
  - reject non-Date object that claims to be date deterministically
- [ ] Inbound codec:
  - for any `data[i][field]` that is string, parse with `new Date(str)` and validate `!isNaN(date.getTime())`
  - on invalid date string, surface deterministic `DFQL_INVALID` with path
- [ ] Tests:
  - TV-CODEC-001/TV-CODEC-001N

## Verification steps

```bash
npm test -w @datafn/client
```

## Stop condition

Before starting Phase 10, report:

- Whether codecs run before/after plugins (ordering).
- Any performance mitigations (e.g., only parse selected fields).

