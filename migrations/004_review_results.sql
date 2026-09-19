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

-- One in-flight review per pull request head. Webhooks and reconciliation both
-- insert jobs, and an application-side existence check only sees committed
-- rows, so a webhook delivered late could otherwise queue a second review for a
-- head the reconciler had already picked up. A completed head may be reviewed
-- again (a reopened pull request), and a check re-run is a deliberate repeat.
CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_inflight_head_idx
  ON review_jobs (repository_id, pull_number, head_sha)
  WHERE status IN ('queued', 'running') AND event_type <> 'check_run.rerequested';
