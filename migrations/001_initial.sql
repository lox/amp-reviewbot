CREATE TABLE IF NOT EXISTS review_jobs (
  id BIGSERIAL PRIMARY KEY,
  source_delivery_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  installation_id BIGINT NOT NULL,
  repository_id BIGINT NOT NULL,
  repository_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  amp_project TEXT NOT NULL,
  check_run_id BIGINT,
  amp_thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS review_jobs_claim_idx
  ON review_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS review_jobs_pull_idx
  ON review_jobs (repository_id, pull_number, created_at DESC);
