# Production monitoring

## Why

The eval in [review-quality-evaluation.md](review-quality-evaluation.md) tells us how the prompt behaves on a frozen corpus. It says nothing about what the deployed service is doing on real pull requests: which reviews blocked, on what, whether a review ever ran at all. Two gaps showed up while landing the `review_threads` cost work:

- A deploy restarted the only webhook listener mid-review. The in-flight review died and the next push's `pull_request` delivery was dropped. GitHub does not retry failed deliveries, so that head had no check run until it was pushed again.
- Once a check run is published, the service keeps nothing about the review except the Amp thread ID. Asking "how often does production block, and on which finding categories" meant opening threads one at a time.

## Approach

Three layers, cheapest and most durable first. Each one is a plain Postgres table plus a loop in the existing worker; no new services.

### Layer 1: record results and reconcile missing reviews (this PR)

`review_results` (migration `004`) stores one row per finished review keyed by `review_jobs.id`: `conclusion`, `fail_on`, `prompt_identifier`, `summary`, blocking / advisory / omitted finding counts, and the retained findings as JSONB. The worker writes it right after the check run is completed; a failed write is logged at warn and does not fail the review, because the GitHub check is the source of truth for the PR author.

`prompt_identifier` is `reviewPromptIdentifier("current", ...)`, the same `name@hash` the eval prints (`current@da7f479098f7` at the time of writing). Production rows and eval experiments in [eval-experiments.md](../eval-experiments.md) can therefore be joined on the exact prompt text.

The reconciler runs every five minutes in `ReviewWorkers.reconcileLoop`. For each repository that already has a row in `review_jobs` (addressed by the installation and name of its latest `pull_request.*` webhook job; re-run and reconciled rows copy coordinates from older rows and are ignored so a stale installation cannot become the newest), it lists the open, non-draft pull requests and queues a review for any head between five minutes and seven days old that has no job for that repo / PR / head. Queued jobs use `sourceDeliveryId = reconcile:<repoId>:<pr>:<headSha>` and `eventType = reconcile.missing_review`, and are logged at warn so a dropped delivery is visible. At most ten jobs are queued per pass.

Settled choices:

- Only repositories with prior jobs are reconciled, so installing the app on a repository with a large backlog of open PRs does not review all of them. The first webhook opts the repository in. Listing per known repository rather than per installation also means one API call per repository per pass, and a repository that can no longer be read (uninstalled, suspended installation, renamed) is logged and skipped without ending the pass.
- The minimum age exists because a push five seconds ago may still have its webhook in flight; the maximum age bounds the backfill after a long outage. Both use the PR's `updated_at`, which also moves on comments, so a stale PR that receives a comment becomes eligible. That is acceptable: a never-reviewed open PR in an opted-in repository should get a review.
- A reconciled job never supersedes other heads. The listing it came from may be seconds stale; if a newer head's webhook job landed in between, cancelling it would leave that head without a review for good (the reconciler skips heads that already have a job of any status). Instead, the worker re-reads the pull request before reviewing and cancels a job whose PR is closed, a draft, or on a newer head. That check already existed for the head; the closed/draft case was added so a PR closed between listing and review is not billed.
- The reverse race, a webhook for a head the reconciler has already queued, is closed in the database. Migration `004` adds a partial unique index over `(repository_id, pull_number, head_sha)` for `queued`/`running` jobs other than check re-runs, and both insert paths absorb the conflict with `ON CONFLICT DO NOTHING`. An application-side existence check alone would not do: it only sees committed rows, and a delivery replayed minutes late (or a manual redelivery from GitHub) would otherwise start a second review and a second check run for the same head. Before building the index the migration cancels every surplus in-flight duplicate (keeping the running one, else the one with a check, else the oldest) so that startup never depends on what historical rows look like. A cancelled duplicate that already owned a GitHub check would leave it in progress forever, so the worker's recovery loop finds those rows by their error text, cancels the check on GitHub, and marks the row; a GitHub failure there is retried on the next pass instead of blocking startup.

### Layer 2: survive deploys

Fly's default rolling strategy stops the old machine before the new one is healthy. With `min_machines_running = 1` and one machine, that is the listener gap observed above. Switch `fly.toml` to `[deploy] strategy = "bluegreen"` so the new machine passes `/healthz` before the old one stops.

During the overlap both machines run a worker. `Database.claim()` uses `FOR UPDATE SKIP LOCKED`, so two workers cannot claim the same job, and webhooks that arrive during the overlap are deduplicated by delivery ID. Reviews already running on the old machine are still aborted when it stops; the existing stale-job recovery restarts them on the new machine with a fresh Amp thread, and the reconciler covers any delivery lost in the remaining window.

This is a one-line config change in its own PR so it can be reverted independently if bluegreen misbehaves with the Postgres attachment.

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

The eval corpus is our only ground truth today. Production ground truth needs a second table, `review_feedback(job_id, verdict, note, created_at)` with `verdict IN ('correct', 'false_block', 'missed')`, filled in by a maintainer after the PR lands: was the block right, was it noise, did a real defect merge with a green check. Ten or twenty rows a month is enough to notice a drift the frozen corpus cannot see, and false blocks with their findings are direct candidates for new corpus examples. This layer is a plan only; do not build the table until there is a habit of reading the queries above.

## Non-goals

- No dashboards or alerting service. `fly logs` plus the warn-level reconciler log is enough at current volume.
- No retention policy for `review_results.findings`. Rows are small and volume is a few reviews per day.
- No automatic re-review when the prompt changes. `prompt_identifier` makes the change visible in the data; it does not trigger work.

## Order

1. `review_results` + reconciler (this PR). Merging runs migration `004`.
2. `fly.toml` bluegreen deploy strategy.
3. Run the layer-3 queries by hand for a few weeks; decide then whether `review_feedback` earns a migration.
