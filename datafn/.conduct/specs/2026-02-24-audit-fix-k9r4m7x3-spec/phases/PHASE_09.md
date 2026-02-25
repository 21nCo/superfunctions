# PHASE 09: Python Fixes (Batch Fetch + Bounded Changes)

## Phase Goal

Fix the N+1 query pattern in the Python sync handler and add bounded change fetching to the Python change tracking module.

## In Scope

- Batch record fetching in Python `handle_pull`
- `limit` parameter for Python `get_changes_since()`
- Python unit tests

## Out of Scope

- Python query push-down (Python server implementation is simpler and less mature)
- Python rate limiting
- Python retention/pruning

## Deliverables

| File | Action |
|---|---|
| `datafn/python/datafn/handlers/sync.py` | MODIFY — batch fetch records |
| `datafn/python/datafn/change_tracking.py` | MODIFY — add limit parameter |
| `datafn/python/tests/test_sync_batch.py` | CREATE — batch fetch tests |
| `datafn/python/tests/test_change_tracking_limit.py` | CREATE — bounded change tests |

## Requirements Covered

- PY-001 (Batch record fetching in Python pull)
- PY-002 (Bounded change fetching in Python)

## Implementation Tasks

1. Modify `datafn/python/datafn/change_tracking.py`:
   - Add `limit` parameter to `get_changes_since()`:
   ```python
   def get_changes_since(self, resource: str, since_seq: int, limit: int | None = None) -> list[ChangeEntry]:
       query = self.db.query("__datafn_changes").where(
           namespace=self.namespace,
           resource=resource,
           server_seq__gt=since_seq
       ).order_by("server_seq")
       if limit is not None:
           query = query.limit(limit)
       return [self._to_entry(row) for row in query.all()]
   ```

2. Modify `datafn/python/datafn/handlers/sync.py`:
   - In `handle_pull`, replace individual record fetches:
   ```python
   # BEFORE (N+1):
   for change in changes:
       if change.op == "upsert":
           record = db.find_one(change.resource, change.id)
           if record:
               records[change.resource].append(record)

   # AFTER (batch):
   upsert_ids_by_resource: dict[str, list[str]] = {}
   for change in changes:
       if change.op in ("upsert", "insert", "merge", "replace"):
           upsert_ids_by_resource.setdefault(change.resource, []).append(change.id)

   fetched_records: dict[str, dict[str, dict]] = {}
   for resource, ids in upsert_ids_by_resource.items():
       rows = db.find_many(resource, where=[{"field": "id", "op": "in", "value": ids}])
       fetched_records[resource] = {r["id"]: r for r in rows}

   for change in changes:
       if change.op in ("upsert", "insert", "merge", "replace"):
           record = fetched_records.get(change.resource, {}).get(change.id)
           if record:
               records[change.resource].append(record)
   ```
   - Pass `limit` to `get_changes_since()` calls

3. Tests:
   - TV-PY-BATCH-001: verify single batch query instead of N individual queries
   - TV-PY-BOUND-001: verify limit enforcement in change tracking

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/python
source venv/bin/activate
pytest tests/test_sync_batch.py tests/test_change_tracking_limit.py -v
pytest tests/ -v  # Full regression
```

**Expected**: All new tests pass. All existing Python tests pass.

## Stop Condition

Report: Python N+1 fixed with batch fetching. Change tracking accepts and enforces limit. No regressions.
