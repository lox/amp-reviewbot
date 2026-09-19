CREATE TABLE IF NOT EXISTS review_results (
  job_id BIGINT PRIMARY KEY REFERENCES review_jobs(id) ON DELETE CASCADE,
  conclusion TEXT NOT NULL CHECK (conclusion IN ('success', 'neutral', 'failure')),
  fail_on TEXT NOT NULL,
  prompt_identifier TEXT NOT NULL,
  summary TEXT NOT NULL,
  blocking_findings INTEGER NOT NULL,
  advisory_findings INTEGER NOT NULL,
  omitted_findings INTEGER NOT NULL,
  findings JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS review_results_created_idx
  ON review_results (created_at);
