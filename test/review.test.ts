import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildReviewPrompt, checkConclusion, parseReviewResult } from "../src/review.js"
import type { ReviewJob } from "../src/types.js"

describe("buildReviewPrompt", () => {
  it("loads the review skills while preserving the trusted diff and output contract", () => {
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
      checkRunId: null,
      ampThreadId: null,
      status: "queued",
      attempts: 0,
    }

    const prompt = buildReviewPrompt(job)

    assert.match(prompt, /load these global skills: general-code-reviewing, adversarial-code-reviewing, and simplicity-review/)
    assert.match(prompt, /Review only changes in base-sha\.\.\.head-sha/)
    assert.match(prompt, /Do not modify any files/)
    assert.match(prompt, /Return only JSON matching this exact shape/)
  })
})

describe("parseReviewResult", () => {
  it("accepts valid JSON", () => {
    const result = parseReviewResult(JSON.stringify({ summary: "Looks good", findings: [] }))
    assert.deepEqual(result, { summary: "Looks good", findings: [] })
  })

  it("accepts a fenced JSON response", () => {
    const result = parseReviewResult(`\`\`\`json
{"summary":"One issue","findings":[{"severity":"high","title":"Race","message":"Two writers can overwrite each other.","path":"src/a.ts","startLine":12}]}
\`\`\``)
    assert.equal(result.findings[0]?.path, "src/a.ts")
    assert.equal(result.findings[0]?.endLine, undefined)
  })

  it("rejects invalid findings", () => {
    assert.throws(() =>
      parseReviewResult(
        JSON.stringify({
          summary: "Bad result",
          findings: [{ severity: "urgent", path: "/etc/passwd", startLine: 0 }],
        }),
      ),
    )
  })
})

describe("checkConclusion", () => {
  const finding = {
    title: "Issue",
    message: "Failure scenario",
    path: "src/a.ts",
    startLine: 1,
  }

  it("succeeds without findings", () => {
    assert.equal(checkConclusion({ summary: "Clean", findings: [] }, "high"), "success")
  })

  it("is neutral below the failure threshold", () => {
    assert.equal(
      checkConclusion({ summary: "Note", findings: [{ ...finding, severity: "medium" }] }, "high"),
      "neutral",
    )
  })

  it("fails at the configured threshold", () => {
    assert.equal(
      checkConclusion({ summary: "Problem", findings: [{ ...finding, severity: "high" }] }, "high"),
      "failure",
    )
  })
})
