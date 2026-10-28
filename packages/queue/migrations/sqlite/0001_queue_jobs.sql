CREATE TABLE IF NOT EXISTS "queue_jobs" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'dead')),
  attempt INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  dedupe_key TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "queue_jobs_available_idx" ON "queue_jobs" (queue, state, available_at, id);

CREATE INDEX IF NOT EXISTS "queue_jobs_lease_idx" ON "queue_jobs" (queue, state, lease_until);

CREATE UNIQUE INDEX IF NOT EXISTS "queue_jobs_dedupe_idx" ON "queue_jobs" (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'leased');
