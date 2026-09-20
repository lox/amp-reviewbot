ALTER TABLE review_threads
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleanup_attempted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS review_threads_unarchived_idx
  ON review_threads (created_at)
  WHERE archived_at IS NULL;
