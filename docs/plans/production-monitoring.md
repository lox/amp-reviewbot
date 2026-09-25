# Production monitoring

## Why

The eval in [review-quality-evaluation.md](review-quality-evaluation.md) tells us how the prompt behaves on a frozen corpus. It says nothing about what the deployed service is doing on real pull requests: which reviews blocked, on what, whether a review ever ran at all. Two gaps showed up while landing the `review_threads` cost work:

- A deploy restarted the only webhook listener mid-review. The in-flight review died and the next push's `pull_request` delivery was dropped. GitHub does not retry failed deliveries, so that head had no check run until it was pushed again.
- After publishing a check, the service kept only the Amp thread ID. Finding out how often production blocked, and why, meant opening threads one at a time.

## Approach

Three layers, cheapest and most durable first. No new services.

### Layer 1: record results and reconcile missing reviews (shipped)

`review_results` (migration `004`) stores one row per finished review keyed by `review_jobs.id`: `conclusion`, `fail_on`, `prompt_identifier`, `summary`, blocking / advisory / omitted finding counts, and the retained findings as JSONB. The worker writes it right after the check run is completed; a failed write is logged at warn and does not fail the review, because the GitHub check is the source of truth for the PR author.

`prompt_identifier` is `reviewPromptIdentifier("current", ...)`, the same `name@hash` the eval prints (`current@da7f479098f7` at the time of writing). Production rows and eval experiments in [eval-experiments.md](../eval-experiments.md) can therefore be joined on the exact prompt text.

`ReviewWorkers.reconcileLoop` runs every five minutes:

1. Find repositories with prior jobs. Use the installation and repository name from the latest `pull_request.*` webhook job, ignoring re-runs and reconciled rows that may have copied stale details.
2. List open, non-draft PRs updated between five minutes and seven days ago.
3. Queue any head with no job for that repository / PR / head, up to ten jobs per pass.

Jobs use `sourceDeliveryId = reconcile:<repoId>:<pr>:<headSha>` and `eventType = reconcile.missing_review`. Each is logged at warn so a missed delivery is visible.

#### Reconciliation rules

- Only repositories with prior jobs are reconciled, so installing the app on a repository with a large backlog of open PRs does not review all of them. The first webhook opts the repository in. Listing per known repository rather than per installation also means one API call per repository per pass, and a repository that can no longer be read (uninstalled, suspended installation, renamed) is logged and skipped without ending the pass.
- The minimum age exists because a push five seconds ago may still have its webhook in flight; the maximum age bounds the backfill after a long outage. Both use the PR's `updated_at`, which also moves on comments, so a stale PR that receives a comment becomes eligible. That is acceptable: a never-reviewed open PR in an opted-in repository should get a review.
- A reconciled job never supersedes other heads. The listing it came from may be seconds stale; if a newer head's webhook job landed in between, cancelling it would leave that head without a review for good (the reconciler skips heads that already have a job of any status). Instead, the worker re-reads the pull request before reviewing and cancels a job whose PR is closed, a draft, or on a newer head. That check already existed for the head; the closed/draft case was added so a PR closed between listing and review is not billed.

#### Webhook/reconciler race

A webhook can arrive after the reconciler has queued the same head. The database closes that race:

- Migration `004` adds a partial unique index over `(repository_id, pull_number, head_sha)` for `queued`/`running` jobs other than check re-runs.
- Both insert paths use `ON CONFLICT DO NOTHING`.
- An application-side existence check is not enough. It sees only committed rows, and a late replay or manual GitHub redelivery could otherwise start a second review and check run.

Before creating the index, the migration cancels surplus in-flight duplicates. It keeps the running row, otherwise the row with a check, otherwise the oldest row. This keeps startup independent of historical duplicates.

A cancelled duplicate may already own a GitHub check. The recovery loop finds those rows by error text, cancels the check on GitHub, and marks the row. If GitHub fails, the next pass retries instead of blocking startup.

### Layer 2: survive deploys (shipped)

Fly's default rolling strategy stops the old machine before the new one is healthy. With `min_machines_running = 1` and one machine, that caused the listener gap above. `fly.toml` now uses `[deploy] strategy = "bluegreen"`, so the new machine passes `/healthz` before the old one stops.

During the overlap both machines run a worker. `Database.claim()` uses `FOR UPDATE SKIP LOCKED`, so two workers cannot claim the same job, and webhooks that arrive during the overlap are deduplicated by delivery ID. Reviews already running on the old machine are still aborted when it stops; the existing stale-job recovery restarts them on the new machine with a fresh Amp thread, and the reconciler covers any delivery lost in the remaining window.

This is a one-line `fly.toml` change and can be reverted independently if bluegreen misbehaves with the Postgres attachment.

### Layer 3: ask questions of the data

Weekly, from `review_results` joined to `review_jobs` and `review_threads`:

```sql
-- Block rate and median blocking findings per prompt over the last 7 days
SELECT prompt_identifier,
       count(*) AS reviews,
       count(*) FILTER (WHERE conclusion = 'failure') AS blocked,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY blocking_findings) AS median_blocking
FROM review_results
WHERE created_at > now() - interval '7 days'
GROUP BY prompt_identifier;

-- Which files and findings block in production
SELECT f->>'path' AS path, f->>'title' AS title, count(*)
FROM review_results r, jsonb_array_elements(r.findings) f
WHERE r.created_at > now() - interval '30 days'
  AND f->>'severity' IN ('high', 'critical')
GROUP BY 1, 2 ORDER BY 3 DESC;

-- Reviews that only exist because of the reconciler
SELECT count(*) FROM review_jobs
WHERE event_type = 'reconcile.missing_review'
  AND created_at > now() - interval '7 days';

-- Cost per blocked review
SELECT r.conclusion, avg(t.amp_usage_usd) AS avg_amp_usd
FROM review_results r JOIN review_threads t ON t.job_id = r.job_id
GROUP BY 1;
```

The eval corpus is our only source-checked reference today. For production feedback, the proposed table is `review_feedback(job_id, verdict, note, created_at)`, with `verdict IN ('correct', 'false_block', 'missed')`.

A maintainer would fill it in after a PR lands: was the block right, was it noise, or did a real defect merge with a green check? Ten or twenty rows a month could reveal problems the frozen corpus misses. False blocks would also make useful new examples.

This table is planned, not built. Start by reading the queries above regularly.

## Non-goals

- No dashboards or alerting service. `fly logs` plus the warn-level reconciler log is enough at current volume.
- No retention policy for `review_results.findings`. Rows are small and volume is a few reviews per day.
- No automatic re-review when the prompt changes. `prompt_identifier` makes the change visible in the data; it does not trigger work.

## Order

1. Shipped: `review_results` + reconciler in migration `004`.
2. Shipped: `fly.toml` bluegreen deploy strategy.
3. Planned: run the layer-3 queries by hand for a few weeks, then decide whether `review_feedback` earns a migration.
