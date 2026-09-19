import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Database, type NewReviewJob } from "../src/database.js"

describe("review context persistence", () => {
  it("stores context with the exact review coordinates", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const database = databaseWithQueries(queries)
    const input: NewReviewJob = {
      sourceDeliveryId: "delivery-1",
      eventType: "pull_request.opened",
      installationId: "1",
      repositoryId: "2",
      repositoryFullName: "lox/example",
      pullNumber: 42,
      baseSha: "base-sha",
      headSha: "head-sha",
      ampProject: "lox/example",
      pullRequestContext: {
        title: "Example change",
        body: "Explains the intended behavior.",
        baseRef: "main",
        headRef: "example-change",
      },
    }

    const job = await database.enqueue(input)

    assert.deepEqual(queries[0]?.values?.slice(9, 13), [
      "Example change",
      "Explains the intended behavior.",
      "main",
      "example-change",
    ])
    assert.deepEqual(job?.pullRequestContext, input.pullRequestContext)
  })

  it("copies the frozen context when a Check is re-run", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const database = databaseWithQueries(queries)

    const job = await database.enqueueRerun("1", "delivery-2", "456")

    assert.match(
      queries[0]!.text,
      /pull_request_title, pull_request_body, base_ref, head_ref, \$3/,
    )
    assert.deepEqual(job?.pullRequestContext, {
      title: "Example change",
      body: "Explains the intended behavior.",
      baseRef: "main",
      headRef: "example-change",
    })
  })

  it("applies the review context migration", async () => {
    const queries: string[] = []
    const database = Object.create(Database.prototype) as Database
    Object.defineProperty(database, "pool", {
      value: { query: async (text: string) => queries.push(text) },
    })

    await database.migrate()

    assert.equal(queries.length, 4)
    assert.match(queries[1]!, /ADD COLUMN IF NOT EXISTS pull_request_title/)
    assert.match(queries[2]!, /CREATE TABLE IF NOT EXISTS review_threads/)
    assert.match(queries[3]!, /CREATE TABLE IF NOT EXISTS review_results/)
  })
})

describe("missing review reconciliation", () => {
  const input: NewReviewJob = {
    sourceDeliveryId: "reconcile:2:42:head-sha",
    eventType: "reconcile.missing_review",
    installationId: "1",
    repositoryId: "2",
    repositoryFullName: "lox/example",
    pullNumber: 42,
    baseSha: "base-sha",
    headSha: "head-sha",
    ampProject: "lox/example",
    pullRequestContext: { title: "Example change", body: null, baseRef: "main", headRef: "example-change" },
  }

  it("inserts only when no job exists for the same repository, pull, and head", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const database = databaseWithQueries(queries)

    const job = await database.enqueueMissing(input)

    const insert = queries[0]!
    assert.match(insert.text, /WHERE NOT EXISTS \(\s*SELECT 1 FROM review_jobs WHERE repository_id = \$4 AND pull_number = \$6 AND head_sha = \$8/)
    assert.deepEqual([insert.values![3], insert.values![5], insert.values![7]], ["2", 42, "head-sha"])
    assert.equal(job?.id, "1")
    assert.equal(
      queries.length,
      1,
      "a reconciled head never supersedes other heads: its listing may predate a newer push whose job must survive",
    )
  })

  it("returns null when the insert found an existing job", async () => {
    const database = Object.create(Database.prototype) as Database
    Object.defineProperty(database, "pool", { value: { query: async () => ({ rows: [] }) } })

    assert.equal(await database.enqueueMissing(input), null)
  })

  it("describes each known repository by its most recent job", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const database = Object.create(Database.prototype) as Database
    Object.defineProperty(database, "pool", {
      value: {
        async query(text: string, values?: unknown[]) {
          queries.push({ text, ...(values ? { values } : {}) })
          return {
            rows: [{ installation_id: "7", repository_id: "2", repository_full_name: "lox/renamed" }],
          }
        },
      },
    })

    const repositories = await database.knownRepositories()

    assert.match(queries[0]!.text, /SELECT DISTINCT ON \(repository_id\)[\s\S]*ORDER BY repository_id, id DESC/)
    assert.deepEqual(repositories, [
      { installationId: "7", repositoryId: "2", repositoryFullName: "lox/renamed" },
    ])
  })
})

describe("review result persistence", () => {
  it("stores the finalized conclusion, counts, and retained findings", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const database = databaseWithQueries(queries)
    const finding = {
      severity: "high" as const,
      title: "Lost write",
      message: "The write is dropped.",
      suggestion: "Keep it.",
      path: "src/a.ts",
      startLine: 3,
    }
    const advisory = { ...finding, severity: "medium" as const, title: "Naming" }

    await database.setResult(
      "7",
      { result: { summary: "One blocker.", findings: [finding, advisory] }, omitted: 2, blocking: 1, conclusion: "failure" },
      { failOn: "high", promptIdentifier: "current@abc123def456" },
    )

    assert.match(queries[0]!.text, /INSERT INTO review_results/)
    assert.deepEqual(queries[0]!.values!.slice(0, 8), [
      "7",
      "failure",
      "high",
      "current@abc123def456",
      "One blocker.",
      1,
      1,
      2,
    ])
    assert.deepEqual(JSON.parse(queries[0]!.values![8] as string), [finding, advisory])
  })
})

describe("review thread usage persistence", () => {
  it("registers each thread while updating the job's current thread", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const database = databaseWithQueries(queries)

    await database.setThread("1", "T-review")

    assert.match(queries[0]!.text, /INSERT INTO review_threads/)
    assert.deepEqual(queries[0]!.values, ["1", "T-review"])
  })

  it("stores Amp usage and the separate estimated provider cost", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const database = databaseWithQueries(queries)
    const usage = {
      costUsd: 1.25,
      estimatedProviderCostAtListPriceUsd: 0.75,
      inputTokens: 1_000,
      outputTokens: 100,
      requests: 2,
      subscriptionUsed: false,
    }

    await database.setThreadUsage("T-review", usage)

    assert.match(queries[0]!.text, /estimated_provider_cost_at_list_price_usd/)
    assert.deepEqual(queries[0]!.values, ["T-review", 1.25, 0.75, JSON.stringify(usage)])
  })

  it("lists only never-collected threads of finished jobs", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const database = databaseWithQueries(queries)

    await database.uncollectedThreadIds(20)

    const text = queries[0]!.text
    assert.match(text, /usage_collected_at IS NULL/)
    assert.match(text, /review_jobs\.status IN \('succeeded', 'failed', 'cancelled'\)/)
    assert.doesNotMatch(text, /'running'/, "a running job's thread is still accruing usage")
    assert.deepEqual(queries[0]!.values, [20])
  })
})

describe("stale review recovery", () => {
  it("requeues jobs below the attempt limit and returns exhausted jobs", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = []
    const rows = [jobRow("1", 2), jobRow("2", 3)]
    const client = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, ...(values ? { values } : {}) })
        return text.includes("SELECT * FROM review_jobs") ? { rows } : { rows: [] }
      },
      release() {},
    }
    const database = Object.create(Database.prototype) as Database
    Object.defineProperty(database, "pool", { value: { connect: async () => client } })

    const recovery = await database.recoverStaleJobs(30 * 60_000, 3)

    assert.equal(recovery.requeued, 1)
    assert.deepEqual(recovery.exhausted.map((job) => job.id), ["2"])
    const update = queries.find((query) => query.text.includes("Recovered after worker interruption"))
    assert.deepEqual(update?.values, [["1"]])
    assert.equal(queries.at(-1)?.text, "COMMIT")
  })
})

function jobRow(id: string, attempts: number) {
  return {
    id,
    source_delivery_id: `delivery-${id}`,
    event_type: "pull_request.opened",
    installation_id: "1",
    repository_id: "2",
    repository_full_name: "lox/example",
    pull_number: 42,
    base_sha: "base-sha",
    head_sha: "head-sha",
    amp_project: "lox/example",
    pull_request_title: "Example change",
    pull_request_body: "Explains the intended behavior.",
    base_ref: "main",
    head_ref: "example-change",
    check_run_id: "123",
    amp_thread_id: "T-12345678-1234-1234-1234-123456789abc",
    status: "running",
    attempts,
  }
}

function databaseWithQueries(queries: Array<{ text: string; values?: unknown[] }>): Database {
  const database = Object.create(Database.prototype) as Database
  Object.defineProperty(database, "pool", {
    value: {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, ...(values ? { values } : {}) })
        return text.includes("INSERT INTO review_jobs")
          ? { rows: [jobRow("1", 0)] }
          : { rows: [] }
      },
    },
  })
  return database
}
