import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { checkConclusion, parseReviewResult } from "../src/review.js"

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
