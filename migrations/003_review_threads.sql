CREATE TABLE IF NOT EXISTS review_threads (
  thread_id TEXT PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
  amp_usage_usd NUMERIC,
  estimated_provider_cost_at_list_price_usd NUMERIC,
  usage_details JSONB,
  usage_error TEXT,
  usage_collected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS review_threads_job_idx
  ON review_threads (job_id, created_at);

INSERT INTO review_threads (job_id, thread_id)
SELECT id, amp_thread_id
FROM review_jobs
WHERE amp_thread_id IS NOT NULL
ON CONFLICT (thread_id) DO NOTHING;
