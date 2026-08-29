import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { finalizeReview, parseReviewResult, reviewResultSchema } from "../src/review.js"

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i, "must be a full 40-character commit SHA")
const artifactHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/i, "must be a sha256 artifact hash")
const conclusionSchema = z.enum(["success", "neutral", "failure"])

const pullRequestContextSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(65_536).nullable(),
  baseRef: z.string().min(1).max(1_000),
  headRef: z.string().min(1).max(1_000),
})

const issueFields = {
  id: z.string().min(1).max(200),
  rootCause: z.string().min(1).max(8_000),
  failureBehavior: z.string().min(1).max(8_000),
  path: z.string().min(1).max(1_000),
  changedLine: z.number().int().positive(),
  evidence: z.array(z.string().min(1).max(8_000)).min(1).max(20),
  verification: z.enum(["executable", "llm-verified"]),
  witnessArtifactHash: artifactHashSchema.optional(),
}

const issueSchema = z.object(issueFields).superRefine((issue, context) => {
  if (issue.verification === "executable" && !issue.witnessArtifactHash) {
    context.addIssue({
      code: "custom",
      path: ["witnessArtifactHash"],
      message: "executable verification requires a witness artifact hash",
    })
  }
})

const expectedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("control"),
    issue: z.null(),
    certification: z.object({
      method: z.literal("llm-adjudicated"),
      evidenceArtifactHash: artifactHashSchema,
    }),
  }),
  z.object({
    kind: z.literal("advisory"),
    issue: issueSchema.extend({ severity: z.enum(["low", "medium"]) }),
  }),
  z.object({
    kind: z.literal("blocking"),
    issue: issueSchema.extend({ severity: z.enum(["high", "critical"]) }),
  }),
])

export const evalCaseSchema = z
  .object({
    id: z.string().min(1).max(200),
    seedId: z.string().min(1).max(200),
    repositoryFullName: z.string().regex(/^[^/]+\/[^/]+$/),
    pullNumber: z.number().int().positive(),
    baseSha: shaSchema,
    headSha: shaSchema,
    ampProject: z.string().min(1),
    context: pullRequestContextSchema,
    changedLines: z.record(
      z.string().min(1),
      z.array(z.number().int().positive()).min(1),
    ),
    expected: expectedSchema,
  })
  .superRefine((evalCase, context) => {
    const issue = evalCase.expected.issue
    if (!issue) return
    if (!evalCase.changedLines[issue.path]?.includes(issue.changedLine)) {
      context.addIssue({
        code: "custom",
        path: ["expected", "issue", "changedLine"],
        message: "expected issue must point to an archived changed line",
      })
    }
  })

export const corpusSchema = z
  .object({
    version: z.string().min(1).max(200),
    cases: z.array(evalCaseSchema).min(1),
  })
  .superRefine((corpus, context) => {
    const seen = new Set<string>()
    const bySeed = new Map<string, Array<{ evalCase: z.infer<typeof evalCaseSchema>; index: number }>>()
    corpus.cases.forEach((evalCase, index) => {
      if (seen.has(evalCase.id)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: `duplicate case id: ${evalCase.id}`,
        })
      }
      seen.add(evalCase.id)

      const seedCases = bySeed.get(evalCase.seedId) ?? []
      seedCases.push({ evalCase, index })
      bySeed.set(evalCase.seedId, seedCases)
    })

    for (const [seedId, seedCases] of bySeed) {
      const kinds = seedCases.map(({ evalCase }) => evalCase.expected.kind).sort()
      if (
        seedCases.length !== 3 ||
        JSON.stringify(kinds) !== JSON.stringify(["advisory", "blocking", "control"])
      ) {
        context.addIssue({
          code: "custom",
          path: ["cases", seedCases[0]!.index, "seedId"],
          message: `seed ${seedId} must contain one control, one advisory, and one blocking case`,
        })
        continue
      }

      if (new Set(seedCases.map(({ evalCase }) => evalCase.headSha)).size !== 3) {
        context.addIssue({
          code: "custom",
          path: ["cases", seedCases[0]!.index, "seedId"],
          message: `cases in seed ${seedId} must use distinct head SHAs`,
        })
      }

      const first = seedCases[0]!.evalCase
      for (const { evalCase, index } of seedCases.slice(1)) {
        if (
          evalCase.repositoryFullName !== first.repositoryFullName ||
          evalCase.pullNumber !== first.pullNumber ||
          evalCase.baseSha !== first.baseSha ||
          evalCase.ampProject !== first.ampProject ||
          JSON.stringify(evalCase.context) !== JSON.stringify(first.context)
        ) {
          context.addIssue({
            code: "custom",
            path: ["cases", index, "seedId"],
            message: `cases in seed ${seedId} must share repository, pull request, base SHA, project, and context`,
          })
        }
      }
    }
  })

const judgementSchema = z.object({
  matchingFindingIndices: z.array(z.number().int().nonnegative()),
  votes: z.array(z.array(z.number().int().nonnegative())).min(2).max(3),
  disagreement: z.boolean(),
  models: z.array(z.string()),
  provenance: z.object({
    version: z.string(),
    mode: z.string(),
    sdkVersion: z.string(),
    project: z.string(),
    promptHash: z.string(),
    schemaHash: z.string(),
  }),
})

const sampleFields = {
  caseId: z.string(),
  sample: z.number().int().positive(),
  expected: expectedSchema,
  promptHash: z.string(),
  threadId: z.string().nullable(),
  models: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
}

const completedSampleSchema = z.object({
  ...sampleFields,
  status: z.literal("completed"),
  rawResult: z.string(),
  parsedResult: reviewResultSchema,
  retainedResult: reviewResultSchema,
  omitted: z.number().int().nonnegative(),
  conclusion: conclusionSchema,
  judgement: judgementSchema.nullable(),
  judgementError: z.string().nullable(),
})

const failedSampleSchema = z.object({
  ...sampleFields,
  status: z.literal("error"),
  error: z.string(),
})

export const evalSampleSchema = z.discriminatedUnion("status", [
  completedSampleSchema,
  failedSampleSchema,
])

export const evalRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusVersion: z.string(),
    corpusHash: artifactHashSchema,
    startedAt: z.string(),
    completedAt: z.string(),
    requestedSamplesPerCase: z.number().int().positive(),
    concurrency: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    reviewer: z.object({
      gitCommit: z.string(),
      dirty: z.boolean(),
      sdkVersion: z.string(),
      mode: z.literal("medium"),
      failOn: z.literal("high"),
      reviewSourceHash: z.string(),
      methodologyHash: z.string(),
    }),
    cases: z.array(evalCaseSchema).min(1),
    samples: z.array(evalSampleSchema).min(1),
  })
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
      if (JSON.stringify(sample.expected) !== JSON.stringify(evalCase.expected)) {
        context.addIssue({
          code: "custom",
          path: ["samples", index, "expected"],
          message: "sample expectation does not match its corpus case",
        })
      }
      if (sample.status === "completed") {
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
              path: ["samples", index],
              message: "sample result does not match its raw production review",
            })
          }
        } catch {
          context.addIssue({
            code: "custom",
            path: ["samples", index, "rawResult"],
            message: "raw result is not valid review JSON",
          })
        }
      }
      if (sample.status === "completed" && sample.judgement) {
        const findingCount = sample.retainedResult.findings.length
        const indices = [
          ...sample.judgement.matchingFindingIndices,
          ...sample.judgement.votes.flat(),
        ]
        if (indices.some((findingIndex) => findingIndex >= findingCount)) {
          context.addIssue({
            code: "custom",
            path: ["samples", index, "judgement"],
            message: "judgement references a finding that was not retained",
          })
        }
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
export type ExpectedResult = z.infer<typeof expectedSchema>
export type EvalSample = z.infer<typeof evalSampleSchema>
export type EvalRun = z.infer<typeof evalRunSchema>

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

export function expectedConclusion(expected: ExpectedResult): z.infer<typeof conclusionSchema> {
  if (expected.kind === "control") return "success"
  return expected.kind === "advisory" ? "neutral" : "failure"
}
