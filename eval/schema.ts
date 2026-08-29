import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { finalizeReview, parseReviewResult, reviewResultSchema } from "../src/review.js"

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i, "must be a full 40-character commit SHA")
const artifactHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/i, "must be a sha256 artifact hash")
const conclusionSchema = z.enum(["success", "neutral", "failure"])

export const pullRequestContextSchema = z
  .object({
    title: z.string().min(1).max(256),
    body: z.string().max(65_536).nullable(),
    baseRef: z.string().min(1).max(1_000),
    headRef: z.string().min(1).max(1_000),
  })
  .strict()

export const expectedIssueSchema = z
  .object({
    id: z.string().min(1).max(200),
    severity: z.enum(["critical", "high", "medium", "low"]),
    rootCause: z.string().min(1).max(8_000),
    failureBehavior: z.string().min(1).max(8_000),
    path: z.string().min(1).max(1_000),
    changedLine: z.number().int().positive(),
    verification: z.string().min(1).max(8_000),
    witness: z.string().min(1).max(1_000).optional(),
  })
  .strict()

const expectedSchema = z
  .object({
    issues: z.array(expectedIssueSchema).max(20),
  })
  .strict()
  .superRefine((expected, context) => {
    const ids = new Set<string>()
    expected.issues.forEach((issue, index) => {
      if (ids.has(issue.id)) {
        context.addIssue({
          code: "custom",
          path: ["issues", index, "id"],
          message: `duplicate known issue id: ${issue.id}`,
        })
      }
      ids.add(issue.id)
    })
  })

export const evalCaseSchema = z
  .object({
    id: z.string().min(1).max(400),
    seedId: z.string().min(1).max(200),
    versionName: z.string().min(1).max(200),
    repositoryFullName: z.string().regex(/^[^/]+\/[^/]+$/),
    pullNumber: z.number().int().positive(),
    baseSha: shaSchema,
    headSha: shaSchema,
    context: pullRequestContextSchema,
    changedLines: z.record(
      z.string().min(1),
      z.array(z.number().int().positive()).min(1),
    ),
    expected: expectedSchema,
  })
  .strict()
  .superRefine((evalCase, context) => {
    evalCase.expected.issues.forEach((issue, index) => {
      if (!evalCase.changedLines[issue.path]?.includes(issue.changedLine)) {
        context.addIssue({
          code: "custom",
          path: ["expected", "issues", index, "changedLine"],
          message: "known issue must point to a line changed by the exact review diff",
        })
      }
    })
  })

export const corpusSchema = z
  .object({
    version: z.string().min(1).max(200),
    cases: z.array(evalCaseSchema).min(1),
  })
  .strict()
  .superRefine((corpus, context) => {
    const ids = new Set<string>()
    const bySeed = new Map<string, Array<{ evalCase: z.infer<typeof evalCaseSchema>; index: number }>>()

    corpus.cases.forEach((evalCase, index) => {
      if (ids.has(evalCase.id)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: `duplicate case id: ${evalCase.id}`,
        })
      }
      ids.add(evalCase.id)
      const cases = bySeed.get(evalCase.seedId) ?? []
      cases.push({ evalCase, index })
      bySeed.set(evalCase.seedId, cases)
    })

    for (const [seedId, cases] of bySeed) {
      const first = cases[0]!.evalCase
      const names = new Set<string>()
      const heads = new Set<string>()
      for (const { evalCase, index } of cases) {
        if (names.has(evalCase.versionName)) {
          context.addIssue({
            code: "custom",
            path: ["cases", index, "versionName"],
            message: `duplicate version name in ${seedId}: ${evalCase.versionName}`,
          })
        }
        if (heads.has(evalCase.headSha)) {
          context.addIssue({
            code: "custom",
            path: ["cases", index, "headSha"],
            message: `versions in ${seedId} must use distinct commits`,
          })
        }
        names.add(evalCase.versionName)
        heads.add(evalCase.headSha)

        if (
          evalCase.repositoryFullName !== first.repositoryFullName ||
          evalCase.pullNumber !== first.pullNumber ||
          evalCase.baseSha !== first.baseSha ||
          !isDeepStrictEqual(evalCase.context, first.context)
        ) {
          context.addIssue({
            code: "custom",
            path: ["cases", index, "seedId"],
            message: `versions in ${seedId} must share their repository, pull request, base commit, and context`,
          })
        }
      }
    }
  })

const judgementFields = {
  issueId: z.string().min(1),
  matchingFindingIndices: z.array(z.number().int().nonnegative()),
  votes: z.array(z.array(z.number().int().nonnegative())).min(2).max(3),
  disagreement: z.boolean(),
  models: z.array(z.string()),
  provenance: z.object({
    version: z.string(),
    mode: z.string(),
    sdkVersion: z.string(),
    project: z.string().nullable(),
    promptHash: z.string(),
    schemaHash: z.string(),
  }),
}

const judgementSchema = z.object(judgementFields).strict()

const sampleFields = {
  caseId: z.string(),
  sample: z.number().int().positive(),
  expected: expectedSchema,
  promptHash: z.string(),
  threadId: z.string().nullable(),
  models: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
}

const completedSampleSchema = z
  .object({
    ...sampleFields,
    status: z.literal("completed"),
    rawResult: z.string(),
    parsedResult: reviewResultSchema,
    retainedResult: reviewResultSchema,
    omitted: z.number().int().nonnegative(),
    conclusion: conclusionSchema,
    judgements: z.array(judgementSchema),
    judgementErrors: z.array(
      z.object({ issueId: z.string().min(1), error: z.string().min(1) }).strict(),
    ),
  })
  .strict()

const failedSampleSchema = z
  .object({
    ...sampleFields,
    status: z.literal("error"),
    error: z.string(),
  })
  .strict()

export const evalSampleSchema = z.discriminatedUnion("status", [
  completedSampleSchema,
  failedSampleSchema,
])

export const evalRunSchema = z
  .object({
    schemaVersion: z.literal(2),
    corpusVersion: z.string(),
    corpusHash: artifactHashSchema,
    startedAt: z.string(),
    completedAt: z.string(),
    requestedSamplesPerCase: z.number().int().positive(),
    concurrency: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    finishedFrom: z
      .object({
        sourceArtifactHash: artifactHashSchema,
        finishedAt: z.string(),
      })
      .strict()
      .optional(),
    reviewer: z.object({
      gitCommit: z.string(),
      dirty: z.boolean(),
      sdkVersion: z.string(),
      mode: z.literal("medium"),
      failOn: z.literal("high"),
      reviewSourceHash: z.string(),
      methodologyHash: z.string(),
      project: z.string().min(1),
      account: z.union([
        z
          .object({
            authentication: z.literal("local-cli"),
          })
          .strict(),
        z
          .object({
            authentication: z.literal("reviewer-api-key"),
            reviewerIdHash: artifactHashSchema,
          })
          .strict(),
        z
          .object({
            separation: z.literal("verified-user-id"),
            trustedIdHash: artifactHashSchema,
            reviewerIdHash: artifactHashSchema,
          })
          .strict(),
      ]),
    }),
    cases: z.array(evalCaseSchema).min(1),
    samples: z.array(evalSampleSchema).min(1),
  })
  .strict()
  .superRefine((run, context) => {
    const expectedCorpusHash = corpusContentHash({
      version: run.corpusVersion,
      cases: run.cases,
    })
    if (run.corpusHash !== expectedCorpusHash) {
      context.addIssue({
        code: "custom",
        path: ["corpusHash"],
        message: "corpus hash does not match the embedded cases",
      })
    }

    const cases = new Map(run.cases.map((evalCase) => [evalCase.id, evalCase]))
    const sampleNumbers = new Map<string, Set<number>>()

    run.samples.forEach((sample, index) => {
      const evalCase = cases.get(sample.caseId)
      if (!evalCase) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "caseId"],
          message: `unknown case id: ${sample.caseId}`,
        })
        return
      }
      if (!isDeepStrictEqual(sample.expected, evalCase.expected)) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "expected"],
          message: "sample expectation does not match its corpus case",
        })
      }
      if (sample.status === "completed") {
        validateCompletedSample(sample, evalCase, index, context)
      }

      const numbers = sampleNumbers.get(sample.caseId) ?? new Set<number>()
      if (numbers.has(sample.sample)) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "sample"],
          message: `duplicate sample number for ${sample.caseId}`,
        })
      }
      numbers.add(sample.sample)
      sampleNumbers.set(sample.caseId, numbers)
    })

    run.cases.forEach((evalCase, index) => {
      const numbers = sampleNumbers.get(evalCase.id)
      const hasEverySample = Array.from(
        { length: run.requestedSamplesPerCase },
        (_, sampleIndex) => sampleIndex + 1,
      ).every((sampleNumber) => numbers?.has(sampleNumber))
      if (numbers?.size !== run.requestedSamplesPerCase || !hasEverySample) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: `case must have exactly ${run.requestedSamplesPerCase} samples`,
        })
      }
    })
  })

export type EvalCase = z.infer<typeof evalCaseSchema>
export type EvalCorpus = z.infer<typeof corpusSchema>
export type ExpectedIssue = z.infer<typeof expectedIssueSchema>
export type ExpectedResult = z.infer<typeof expectedSchema>
export type EvalSample = z.infer<typeof evalSampleSchema>
export type EvalRun = z.infer<typeof evalRunSchema>
export type EvalJudgement = z.infer<typeof judgementSchema>

function validateCompletedSample(
  sample: z.infer<typeof completedSampleSchema>,
  evalCase: EvalCase,
  sampleIndex: number,
  context: z.RefinementCtx,
): void {
  try {
    const parsedResult = parseReviewResult(sample.rawResult)
    const finalized = finalizeReview(parsedResult, changedLineMap(evalCase), "high")
    const consistent =
      isDeepStrictEqual(sample.parsedResult, parsedResult) &&
      isDeepStrictEqual(sample.retainedResult, finalized.result) &&
      sample.omitted === finalized.omitted &&
      sample.conclusion === finalized.conclusion
    if (!consistent) {
      context.addIssue({
        code: "custom",
        path: ["samples", sampleIndex],
        message: "sample result does not match its raw production review",
      })
    }
  } catch {
    context.addIssue({
      code: "custom",
      path: ["samples", sampleIndex, "rawResult"],
      message: "raw result is not valid review JSON",
    })
  }

  const expectedIssueIds = new Set(evalCase.expected.issues.map((issue) => issue.id))
  const resolvedIssueIds = new Set<string>()
  sample.judgements.forEach((judgement, judgementIndex) => {
    validateIssueResult(judgement.issueId, judgementIndex, "judgements")
    const findingCount = sample.retainedResult.findings.length
    const indices = [...judgement.matchingFindingIndices, ...judgement.votes.flat()]
    if (indices.some((findingIndex) => findingIndex >= findingCount)) {
      context.addIssue({
        code: "custom",
        path: ["samples", sampleIndex, "judgements", judgementIndex],
        message: "judgement references a finding that was not retained",
      })
    }
  })
  sample.judgementErrors.forEach((result, resultIndex) => {
    validateIssueResult(result.issueId, resultIndex, "judgementErrors")
  })

  function validateIssueResult(
    issueId: string,
    resultIndex: number,
    field: "judgements" | "judgementErrors",
  ): void {
    if (!expectedIssueIds.has(issueId)) {
      context.addIssue({
        code: "custom",
        path: ["samples", sampleIndex, field, resultIndex, "issueId"],
        message: `unknown known issue id: ${issueId}`,
      })
    }
    if (resolvedIssueIds.has(issueId)) {
      context.addIssue({
        code: "custom",
        path: ["samples", sampleIndex, field, resultIndex, "issueId"],
        message: `known issue was checked more than once: ${issueId}`,
      })
    }
    resolvedIssueIds.add(issueId)
  }
}

function changedLineMap(evalCase: EvalCase): Map<string, Set<number>> {
  return new Map(
    Object.entries(evalCase.changedLines).map(([path, lines]) => [path, new Set(lines)]),
  )
}

export function corpusContentHash(corpus: {
  version: string
  cases: readonly unknown[]
}): string {
  return `sha256:${createHash("sha256").update(canonicalJson(corpus)).digest("hex")}`
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortKeys(item)]),
  )
}

export function expectedKind(expected: ExpectedResult): "control" | "advisory" | "blocking" {
  if (expected.issues.length === 0) return "control"
  return expected.issues.some((issue) => issue.severity === "critical" || issue.severity === "high")
    ? "blocking"
    : "advisory"
}

export function expectedConclusion(expected: ExpectedResult): z.infer<typeof conclusionSchema> {
  const kind = expectedKind(expected)
  if (kind === "control") return "success"
  return kind === "advisory" ? "neutral" : "failure"
}
