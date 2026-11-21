-- Source-keyed documents: the chunks of one source share source_key and content_hash.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS chunk_index integer;
CREATE INDEX IF NOT EXISTS idx_memories_live_source ON memories (tenant_id, source_key) WHERE deleted_at IS NULL;
