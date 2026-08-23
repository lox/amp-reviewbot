import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Database } from "../src/database.js"

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
    check_run_id: "123",
    amp_thread_id: "T-12345678-1234-1234-1234-123456789abc",
    status: "running",
    attempts,
  }
}
