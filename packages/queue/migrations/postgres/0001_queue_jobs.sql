CREATE TABLE IF NOT EXISTS "queue_jobs" (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue TEXT NOT NULL,
  payload JSON NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'dead')),
  attempt INTEGER NOT NULL DEFAULT 0,
  available_at BIGINT NOT NULL,
  lease_until BIGINT,
  dedupe_key TEXT,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS "queue_jobs_available_idx" ON "queue_jobs" (queue, state, available_at, id);

CREATE INDEX IF NOT EXISTS "queue_jobs_lease_idx" ON "queue_jobs" (queue, state, lease_until);

CREATE UNIQUE INDEX IF NOT EXISTS "queue_jobs_dedupe_idx" ON "queue_jobs" (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'leased');
