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
