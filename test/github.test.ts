import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Config } from "../src/config.js"
import { GitHubClient, checkTitle, parseChangedLines } from "../src/github.js"
import type { ReviewJob } from "../src/types.js"

const job: ReviewJob = {
  id: "job-1",
  sourceDeliveryId: "delivery-1",
  eventType: "pull_request.opened",
  installationId: "1",
  repositoryId: "2",
  repositoryFullName: "lox/example",
  pullNumber: 42,
  baseSha: "base-sha",
  headSha: "head-sha",
  ampProject: "lox/example",
  checkRunId: "123",
  ampThreadId: "T-12345678-1234-1234-1234-123456789abc",
  status: "running",
  attempts: 1,
}

describe("check details link", () => {
  it("links an in-progress check to its Amp thread", async () => {
    const { client, updates } = githubClient()

    await client.linkCheck(job, job.checkRunId!, job.ampThreadId!)

    assert.equal(updates[0]?.details_url, `https://ampcode.com/threads/${job.ampThreadId}`)
  })

  it("keeps the Amp thread link when a review fails", async () => {
    const { client, updates } = githubClient()

    await client.failCheck(job, job.checkRunId!, "Review could not complete.")

    assert.equal(updates[0]?.details_url, `https://ampcode.com/threads/${job.ampThreadId}`)
    assert.equal(updates[0]?.conclusion, "failure")
  })
})

describe("checkTitle", () => {
  it("describes clean, advisory, and blocking results", () => {
    assert.equal(checkTitle(0, "success"), "No issues found")
    assert.equal(checkTitle(1, "neutral"), "1 advisory issue")
    assert.equal(checkTitle(2, "failure"), "2 blocking issues")
  })
})

describe("parseChangedLines", () => {
  it("returns right-side line numbers for additions across hunks", () => {
    const patch = `@@ -2,4 +2,5 @@
 context
-removed
+first addition
+second addition
 context
@@ -20,2 +21,3 @@
 context
+later addition
 context`

    assert.deepEqual([...parseChangedLines(patch)], [3, 4, 22])
  })

  it("handles a newly added file", () => {
    const patch = `@@ -0,0 +1,2 @@
+one
+two`
    assert.deepEqual([...parseChangedLines(patch)], [1, 2])
  })
})

function githubClient(): { client: GitHubClient; updates: Record<string, unknown>[] } {
  const updates: Record<string, unknown>[] = []
  const client = new GitHubClient({
    githubAppId: 123,
    githubPrivateKey: "test-key",
    failOn: "high",
  } as Config)
  Object.defineProperty(client, "app", {
    value: {
      getInstallationOctokit: async () => ({
        rest: {
          checks: {
            update: async (input: Record<string, unknown>) => {
              updates.push(input)
            },
          },
        },
      }),
    },
  })
  return { client, updates }
}
