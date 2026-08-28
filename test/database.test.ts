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

    assert.equal(queries.length, 2)
    assert.match(queries[1]!, /ADD COLUMN IF NOT EXISTS pull_request_title/)
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
