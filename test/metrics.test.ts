import assert from "node:assert/strict"
import { once } from "node:events"
import { it } from "node:test"
import { PGlite } from "@electric-sql/pglite"
import pino from "pino"
import { Database } from "../src/database.js"
import { createMetricsServer } from "../src/metrics.js"

it("aggregates durable jobs, latency and retry costs without multiplying results", async (t) => {
  const pg = new PGlite()
  t.after(() => pg.close())
  const database = Object.create(Database.prototype) as Database
  Object.defineProperty(database, "pool", { value: {
    query: (query: string | { text: string }) => typeof query === "string"
      ? pg.exec(query) : pg.query(query.text),
  } })
  await database.migrate()
  const empty = await database.metrics()
  assert.equal(Number(empty.reviews), 0)
  assert.equal(Number(empty.amp_usage_usd), 0)
  assert.equal(empty.latency_p95_seconds_24h, null)
  assert.equal(empty.queue_delay_mean_seconds_24h, null)
  assert.equal(empty.queue_delay_p95_seconds_24h, null)
  // One transaction fixes now(), so the 24-hour boundary is exact.
  await pg.exec(`BEGIN;
    INSERT INTO review_jobs (source_delivery_id, event_type, installation_id, repository_id,
      repository_full_name, pull_number, base_sha, head_sha, amp_project,
      status, created_at, completed_at, started_at)
    SELECT id::text, 'pull_request.opened', 1, 1, 'private/repo', id, 'base', id::text, 'private/repo',
      status, now() - age * interval '1 second',
      CASE WHEN duration IS NULL THEN NULL ELSE now() - (age - duration) * interval '1 second' END,
      CASE WHEN delay IS NULL THEN NULL ELSE now() - (age - delay) * interval '1 second' END
    FROM (VALUES (1, 'succeeded', 120, 60, 10), (2, 'failed', 500, 300, 40),
      (3, 'cancelled', 1000, 900, 400), (4, 'succeeded', 86500, 100, 100),
      (5, 'queued', 42, NULL, NULL), (6, 'running', 80, NULL, 70)) AS v(id, status, age, duration, delay);
    INSERT INTO review_threads (thread_id, job_id, amp_usage_usd,
      estimated_provider_cost_at_list_price_usd, usage_collected_at, usage_error)
    VALUES ('retry', 1, 1.25, 2, now(), NULL), ('final', 1, 0.75, NULL, now(), NULL),
      ('failed', 2, 3, 4, now(), NULL), ('pending', 6, NULL, NULL, NULL, NULL),
      ('error', 3, NULL, NULL, now(), 'unavailable');
    INSERT INTO review_results (job_id, conclusion, fail_on, prompt_identifier, summary,
      blocking_findings, advisory_findings, omitted_findings, findings)
    VALUES (1, 'failure', 'high', 'test', 'private summary', 2, 3, 0, '[]');`)
  const { queue_delay_p95_seconds_24h, ...metrics } = await database.metrics()
  assert.ok(Math.abs(Number(queue_delay_p95_seconds_24h) - 350.5) < 1e-9)
  assert.deepEqual(Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Number(value)])), {
    reviews: 6, queued: 1, running: 1, succeeded: 2, failed: 1, cancelled: 1,
    oldest_queued_seconds: 42, completed_24h: 2, latency_mean_seconds_24h: 180,
    started_24h: 4, queue_delay_mean_seconds_24h: 130,
    latency_p95_seconds_24h: 288, amp_usage_usd: 5, provider_list_price_usd: 6,
    threads_with_amp_usage: 3, threads_with_provider_estimate: 2, threads_usage_pending: 1,
    threads_usage_errors: 1, results: 1, blocked: 1, blocking_findings: 2, advisory_findings: 3,
  })
  await pg.exec("ROLLBACK")
})

it("exports numeric database snapshots, preserves unknown latency, and rejects other routes", async (t) => {
  let calls = 0
  const server = createMetricsServer({ metrics: async () => {
    calls++
    return { reviews: "7", amp_usage_usd: "1.25", latency_p95_seconds_24h: null }
  } }, pino({ level: "silent" }))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${url}/metrics`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type")!, /text\/plain; version=0.0.4/)
  assert.equal(await response.text(), "# TYPE reviewbot_reviews gauge\nreviewbot_reviews 7\n" +
    "# TYPE reviewbot_amp_usage_usd gauge\nreviewbot_amp_usage_usd 1.25\n" +
    "# TYPE reviewbot_latency_p95_seconds_24h gauge\nreviewbot_latency_p95_seconds_24h NaN\n")
  assert.equal((await fetch(`${url}/metrics`, { method: "POST" })).status, 404)
  assert.equal((await fetch(`${url}/other`)).status, 404)
  assert.equal(calls, 1)
})

it("fails the scrape instead of publishing zeroes or leaking database errors", async (t) => {
  const server = createMetricsServer({ metrics: async () => { throw new Error("private details") } },
    pino({ level: "silent" }))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const response = await fetch(`http://127.0.0.1:${address.port}/metrics`)
  assert.equal(response.status, 503)
  assert.equal(await response.text(), "metrics collection failed\n")
})
