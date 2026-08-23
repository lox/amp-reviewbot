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
  it("describes clean, advisory, blocking, and mixed results", () => {
    assert.equal(checkTitle(0, 0), "No issues found")
    assert.equal(checkTitle(0, 1), "1 advisory issue")
    assert.equal(checkTitle(2, 0), "2 blocking issues")
    assert.equal(checkTitle(1, 2), "1 blocking issue, 2 advisory issues")
  })
})

describe("completed check output", () => {
  it("separates blocking and advisory findings and uses Markdown only in check text", async () => {
    const { client, updates } = githubClient()

    await client.completeCheck(
      job,
      job.checkRunId!,
      {
        summary: "The review found migration and documentation risks.",
        findings: [
          {
            severity: "high",
            title: "Unsafe rollback",
            message: "The old application cannot read the migrated schema.",
            suggestion: "Keep the legacy column during the compatibility window.",
            path: "src/database.ts",
            startLine: 101,
          },
          {
            severity: "medium",
            title: "Missing permission",
            message: "Push events cannot be enabled with these permissions.",
            suggestion: "Add Contents read permission.",
            path: "README.md",
            startLine: 23,
          },
        ],
      },
      new Map([
        ["src/database.ts", new Set([101])],
        ["README.md", new Set([23])],
      ]),
    )

    const update = updates[0]!
    const output = update.output as {
      title: string
      summary: string
      text: string
      annotations: { message: string }[]
    }
    assert.equal(output.title, "1 blocking issue, 1 advisory issue")
    assert.equal(output.summary, "The review found migration and documentation risks.")
    assert.match(output.text, /\*\*Suggested fix:\*\*/)
    assert.match(output.text, /`src\/database\.ts:101`/)
    assert.doesNotMatch(output.annotations[0]!.message, /\*\*/)
    assert.match(output.annotations[0]!.message, /Suggested fix: Keep the legacy column/)
  })

  it("does not summarize findings omitted from GitHub annotations", async () => {
    const { client, updates } = githubClient()

    await client.completeCheck(
      job,
      job.checkRunId!,
      {
        summary: "A legacy file contains a blocking issue.",
        findings: [
          {
            severity: "high",
            title: "Legacy issue",
            message: "This line was not changed by the pull request.",
            suggestion: "Fix the legacy implementation separately.",
            path: "src/legacy.ts",
            startLine: 10,
          },
        ],
      },
      new Map([["src/legacy.ts", new Set([11])]]),
    )

    const output = updates[0]!.output as { title: string; summary: string }
    assert.equal(output.title, "No issues found")
    assert.equal(output.summary, "_1 finding(s) omitted because they did not reference a changed line._")
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
