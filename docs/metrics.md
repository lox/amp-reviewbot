# Fly Grafana metrics

Fly scrapes the private `0.0.0.0:9091/metrics` listener every 15 seconds after
deploying this configuration. Port 9091 is not exposed by the public HTTP service.
There are no repository, PR, thread, or user labels or contents in the export.

Open [Fly's managed Grafana](https://fly-metrics.net), select the app's organization,
and use its preconfigured Prometheus datasource. Create panels with the queries below.
These are database-wide **gauges**: use `max`, never `sum` across Fly instances
(including blue/green deploy overlap), and do not apply `rate` to them.

| Panel | PromQL | Unit |
| --- | --- | --- |
| Reviews received, all time | `max(reviewbot_reviews{app="lox-amp-reviewbot"})` | count |
| Reviews completed, last 24h | `max(reviewbot_completed_24h{app="lox-amp-reviewbot"})` | count |
| Queued | `max(reviewbot_queued{app="lox-amp-reviewbot"})` | count |
| Running | `max(reviewbot_running{app="lox-amp-reviewbot"})` | count |
| Execution failures, all time | `max(reviewbot_failed{app="lox-amp-reviewbot"})` | count |
| Cancelled, all time | `max(reviewbot_cancelled{app="lox-amp-reviewbot"})` | count |
| Oldest queued job | `max(reviewbot_oldest_queued_seconds{app="lox-amp-reviewbot"})` | seconds |
| Mean queue delay, last 24h | `max(reviewbot_queue_delay_mean_seconds_24h{app="lox-amp-reviewbot"})` | seconds |
| P95 queue delay, last 24h | `max(reviewbot_queue_delay_p95_seconds_24h{app="lox-amp-reviewbot"})` | seconds |
| Mean end-to-end latency, last 24h | `max(reviewbot_latency_mean_seconds_24h{app="lox-amp-reviewbot"})` | seconds |
| P95 end-to-end latency, last 24h | `max(reviewbot_latency_p95_seconds_24h{app="lox-amp-reviewbot"})` | seconds |
| Recorded Amp usage, all time | `max(reviewbot_amp_usage_usd{app="lox-amp-reviewbot"})` | USD |
| Recorded provider list-price estimate, all time | `max(reviewbot_provider_list_price_usd{app="lox-amp-reviewbot"})` | USD |
| Blocking reviews, all time | `max(reviewbot_blocked{app="lox-amp-reviewbot"})` | count |
| Block rate among recorded results | `max(reviewbot_blocked{app="lox-amp-reviewbot"}) / max(reviewbot_results{app="lox-amp-reviewbot"})` | percent (0–1) |
| Blocking findings, all time | `max(reviewbot_blocking_findings{app="lox-amp-reviewbot"})` | count |
| Advisory findings, all time | `max(reviewbot_advisory_findings{app="lox-amp-reviewbot"})` | count |
| Usage pending | `max(reviewbot_threads_usage_pending{app="lox-amp-reviewbot"})` | count |
| Usage errors | `max(reviewbot_threads_usage_errors{app="lox-amp-reviewbot"})` | count |

`reviewbot_succeeded` counts successful executions, including reviews that found
blocking issues. `reviewbot_failed` counts infrastructure/execution failures;
`reviewbot_blocked` counts recorded results with a blocking conclusion. Result
recording is best effort, so `reviewbot_results` can be lower than succeeded jobs.

Latency is creation to completion for succeeded and failed jobs completed in the
last 24 hours. It includes queueing, retries and downtime, and excludes cancellations.
No samples exports `NaN`, not a zero latency. The 24-hour window is fixed and does
not follow Grafana's time picker; graphing it shows the rolling statistic over time.

Queue delay separately measures `started_at - created_at` for every job with
`started_at` in the last 24 hours, including running and subsequently cancelled jobs.
`reviewbot_started_24h` gives the sample count. Use a 300-second threshold on the P95
panel to evaluate the queue P95 <5m target. Retries overwrite `started_at`, so this
measures creation to latest start, not first-attempt wait; requeued jobs with a cleared
`started_at` are absent until claimed again. Empty populations export `NaN`.

Costs include every recorded thread, including failed/cancelled attempts and retries.
Amp usage and provider list-price estimates are different measures: do not add them.
Missing usage is not a known zero cost; display pending/errors beside cost and use
`reviewbot_threads_with_amp_usage` / `reviewbot_threads_with_provider_estimate` to
inspect coverage. Costs appear when cleanup records usage, not while reviews run.

Snapshots survive restarts and include existing database history, but deleting rows
reduces totals. Fly retains time series for approximately 15 days; Postgres remains
the source of historical detail. Scrapes aggregate the tables without joining raw
jobs to threads/results (which would multiply counts). At current low volume this
avoids a new metrics store; revisit aggregation cost if those tables grow substantially.
Database failures return HTTP 503 rather than misleading zeroes.

Deployment and dashboard creation are separate delivery steps. After deployment,
verify `reviewbot_reviews{app="lox-amp-reviewbot"}` in Grafana Explore before adding
panels. The webhook listener continues to return 404 for `/metrics`.

## Recent reviews table

The service reads the latest 100 finished jobs from the last seven days every
60 seconds and emits `event: "review_summary"` JSON logs when a snapshot changes.
Startup re-emits that bounded history. This includes failed/cancelled jobs and
jobs with no thread; it does not delay reviews or trigger usage lookups. Late
usage updates are reflected while a job remains in that recent window. This is
a recent activity view, not a complete historical ledger or an exactly-once event stream.
Keep `LOG_LEVEL=info` (the default) to enable these records.

Use **Application Logs (VictoriaLogs)**, not Prometheus, for a Grafana Table panel.
The [panel JSON](recent-reviews-panel.json) contains the query, transformations,
column formatting and PR links. Add it to the existing dashboard with a unique
panel ID and non-overlapping grid position after deploying the exporter.
Choose Raw Logs (`queryType: instant`), extract JSON fields from `labels`, then
convert duration/cost/count fields to numbers and `completedAt` to a time field.
Use seconds for durations and USD for both cost columns. Link `pullRequestUrl`
directly to the PR. This query keeps the latest snapshot per review, avoiding
duplicate rows from cost updates, restarts and blue/green machines:

```logsql
options(ignore_global_time_filter=true)
_time:7d fly.app.name:="lox-amp-reviewbot" "review_summary"
| unpack_json
| filter event:="review_summary"
| stats by (reviewId) row_max(_time) as snapshot
| unpack_json from snapshot
| filter completedAt:string_range("${__from:date:iso}", "${__to:date:iso}")
| sort by (completedAt desc)
| limit 100
| format if (queueSeconds:"") "NaN" as queueSeconds
| format if (executionSeconds:"") "NaN" as executionSeconds
| format if (ampUsageUsd:"") "NaN" as ampUsageUsd
| format if (providerEstimateUsd:"") "NaN" as providerEstimateUsd
| fields _time, completedAt, reviewId, pullRequest, pullRequestUrl, status, conclusion, attempts, queueSeconds, executionSeconds, totalSeconds, ampUsageUsd, providerEstimateUsd, threads, ampUsageThreads, providerEstimateThreads, usagePending, usageErrors
```

The `NaN` sentinels are intentional: Fly's Grafana 11.2.2 converts empty/null
fields to zero when changing field type to Number, but converts `NaN` to null.
Do not remove this step; real zero costs must remain distinct from missing usage.

The time picker filters **completion time**, not when a snapshot was logged.
`queueSeconds` is creation to latest start; `executionSeconds` is latest start to
completion, not total execution across interrupted attempts. `totalSeconds`
includes all queueing and retries. Null timings mean a job never started, not
a zero-second review. For speed comparisons, separate failed/cancelled jobs and
compare similar workloads with sample counts; concurrency mainly changes queueing.

Costs sum every thread of that job, including retries. Unknown totals stay null;
partial totals must be read alongside `ampUsageThreads` / `providerEstimateThreads`
versus `threads`, plus `usagePending` and `usageErrors`. A zero recorded cost is
different from missing usage. No review text or findings are logged in these
snapshots. PR URLs and review IDs are log fields only, never Prometheus labels.
