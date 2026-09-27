import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { it } from "node:test"
import { PGlite } from "@electric-sql/pglite"
import pino from "pino"
import { Database } from "../src/database.js"
import { logReviewSummaries } from "../src/review-summaries.js"

it("snapshots timings and partial retry costs without duplicating reviews or inventing zero costs", async (t) => {
  const pg = new PGlite()
  t.after(() => pg.close())
  const database = Object.create(Database.prototype) as Database
  Object.defineProperty(database, "pool", { value: {
    query: async (text: string) => (await pg.exec(text)).at(-1),
  } })
  await database.migrate()
  await pg.exec(`BEGIN;
    INSERT INTO review_jobs (id, source_delivery_id, event_type, installation_id, repository_id,
      repository_full_name, pull_number, base_sha, head_sha, amp_project, status, attempts,
      created_at, started_at, completed_at)
    SELECT id, id::text, 'pull_request.opened', 1, 1, 'owner/repo', 42, 'base', id::text,
      'project', status, attempts, now() - age * interval '1 second',
      CASE WHEN delay IS NOT NULL THEN now() - (age - delay) * interval '1 second' END,
      CASE WHEN duration IS NOT NULL THEN now() - (age - duration) * interval '1 second' END
    FROM (VALUES (1, 'succeeded', 2, 700, 300, 600), (2, 'cancelled', 0, 50, NULL, 10),
      (3, 'failed', 1, 200, 20, 80), (4, 'running', 1, 5, 1, NULL),
      (5, 'succeeded', 1, 604810, 1, 10)) AS v(id,status,attempts,age,delay,duration);
    INSERT INTO review_threads (thread_id,job_id,amp_usage_usd,estimated_provider_cost_at_list_price_usd,usage_collected_at,usage_error)
    VALUES ('retry',1,1.25,2,now(),NULL),('final',1,0.75,NULL,now(),NULL),
      ('pending',1,NULL,NULL,NULL,NULL),('error',3,NULL,NULL,now(),'timeout');
    INSERT INTO review_results (job_id,conclusion,fail_on,prompt_identifier,summary,blocking_findings,advisory_findings,omitted_findings,findings)
    VALUES (1,'failure','high','test','private text',1,0,0,'[]');`)
  const rows = await database.recentReviewSummaries()
  assert.deepEqual(rows.map(r => r.reviewId), ["2", "1", "3"])
  const { completedAt, ...succeeded } = rows[1]!
  assert.ok(completedAt)
  assert.deepEqual(succeeded, {
    reviewId: "1", pullRequest: "owner/repo#42", pullRequestUrl: "https://github.com/owner/repo/pull/42", status: "succeeded",
    conclusion: "failure", attempts: 2, queueSeconds: 300, executionSeconds: 300, totalSeconds: 600,
    threads: 3, ampUsageUsd: 2, providerEstimateUsd: 2, ampUsageThreads: 2,
    providerEstimateThreads: 1, usagePending: 1, usageErrors: 0,
  })
  assert.equal(rows[0]!.queueSeconds, null)
  assert.equal(rows[0]!.executionSeconds, null)
  assert.equal(rows[0]!.ampUsageUsd, null)
  assert.equal(rows[0]!.threads, 0)
  assert.equal(rows[2]!.ampUsageUsd, null)
  assert.equal(rows[2]!.usageErrors, 1)
  await pg.exec("UPDATE review_threads SET amp_usage_usd=0, usage_collected_at=now() WHERE thread_id='pending'")
  const updated = (await database.recentReviewSummaries())[1]!
  assert.equal(updated.usagePending, 0)
  assert.equal(updated.ampUsageThreads, 3)
  assert.equal(updated.ampUsageUsd, 2)
  await pg.exec(`INSERT INTO review_jobs (id,source_delivery_id,event_type,installation_id,repository_id,
    repository_full_name,pull_number,base_sha,head_sha,amp_project,status,completed_at)
    SELECT n,'extra-'||n,'test',1,1,'owner/repo',n,'base',n::text,'project','succeeded',now()
    FROM generate_series(100,200) n`)
  const bounded = await database.recentReviewSummaries()
  assert.equal(bounded.length, 100)
  assert.equal(bounded.some(r => r.reviewId === "1"), false)
  await pg.exec("ROLLBACK")
})

it("logs initial snapshots and late cost changes, survives query errors, and stops promptly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const records: Array<Record<string, unknown>> = []
  const logger = pino({ level: "info" }, { write(line) { records.push(JSON.parse(line)) } })
  const initial = { reviewId: "7", ampUsageUsd: null, usagePending: 1 }
  const updated = { reviewId: "7", ampUsageUsd: 0, usagePending: 0 }
  let calls = 0
  const controller = new AbortController()
  const loop = logReviewSummaries({ recentReviewSummaries: async () => {
    calls++
    if (calls === 4) throw new Error("database unavailable")
    return [calls < 3 ? initial : updated]
  } }, logger, controller.signal)
  await setImmediate()
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(60_000)
    await setImmediate()
  }
  controller.abort()
  await loop
  assert.equal(calls, 5)
  assert.deepEqual(records.filter(r => r.event === "review_summary").map(r => r.ampUsageUsd), [null, 0])
  assert.equal(records.filter(r => r.msg === "could not collect review summaries").length, 1)
})
