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
-- over them, so every surplus duplicate is cancelled first: startup must never
-- depend on what historical rows happen to look like. The surviving job per
-- head is the running one, else the one that owns a check, else the oldest. A
-- cancelled duplicate that already owned a GitHub check (it was running, or
-- was requeued and kept its check) would leave that check in progress forever;
-- the worker's recovery loop finds such rows by the error text below and
-- closes their checks. The whole file runs as one implicit transaction, and
-- once the index exists this update finds nothing.
UPDATE review_jobs
SET status = 'cancelled', completed_at = NOW(), updated_at = NOW(),
    error = 'Duplicate in-flight review for the same pull request head'
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY repository_id, pull_number, head_sha
      ORDER BY status <> 'running', check_run_id IS NULL, id
    ) AS position
    FROM review_jobs
    WHERE status IN ('queued', 'running') AND event_type <> 'check_run.rerequested'
  ) ranked
  WHERE position > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS review_jobs_inflight_head_idx
  ON review_jobs (repository_id, pull_number, head_sha)
  WHERE status IN ('queued', 'running') AND event_type <> 'check_run.rerequested';
