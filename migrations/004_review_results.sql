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
--
-- Earlier schemas allowed such duplicates (two deliveries for one head, for
-- example a reopen after a dropped close), and the index would refuse to build
-- over them. Cancel all but one job in each group first, preferring to keep a
-- job that is already running; the whole file runs as one implicit
-- transaction, and once the index exists this update finds nothing.
UPDATE review_jobs
SET status = 'cancelled', completed_at = NOW(), updated_at = NOW(),
    error = 'Duplicate in-flight review for the same pull request head'
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY repository_id, pull_number, head_sha
      ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, id
    ) AS position
    FROM review_jobs
    WHERE status IN ('queued', 'running') AND event_type <> 'check_run.rerequested'
  ) ranked
  WHERE position > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_inflight_head_idx
  ON review_jobs (repository_id, pull_number, head_sha)
  WHERE status IN ('queued', 'running') AND event_type <> 'check_run.rerequested';
