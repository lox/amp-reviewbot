import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import {
  applySeverityRatings,
  blockingFindingIndices,
  checkConclusion,
  finalizeReview,
  parseReviewResult,
  parseSeverityRepassResult,
  reviewResultSchema,
  severityRepassResultSchema,
} from "../src/review.js"

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i, "must be a full 40-character commit SHA")
const artifactHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/i, "must be a sha256 artifact hash")
const conclusionSchema = z.enum(["success", "neutral", "failure"])
const rescoreDropSchema = z.discriminatedUnion("reason", [
  z
    .object({
      caseId: z.string().min(1),
      reason: z.literal("not-in-pack"),
    })
    .strict(),
  z
    .object({
      caseId: z.string().min(1),
      reason: z.literal("review-input-changed"),
      fields: z.array(z.enum(["commit", "PR context", "prepared source"])).min(1),
    })
    .strict(),
  z
    .object({
      caseId: z.string().min(1),
      reason: z.literal("recorded-issue-changed"),
      issueIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
])
export const exampleOriginSchema = z.enum(["pilot", "human-review", "synthetic"])
export const exampleSplitSchema = z.enum(["development", "holdout"])
export const versionRoleSchema = z.enum(["baseline", "introduced-issue"])
export const issueNatureSchema = z.enum(["behavioral-defect", "maintainability-advisory"])
export const issueCategorySchema = z.enum([
  "functional-correctness",
  "concurrency",
  "resource-lifecycle",
  "error-handling",
  "api-contract",
  "maintainability",
])
export const issueSubtypeSchema = z.enum(["duplication", "non-idiomatic-go"])

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
    nature: issueNatureSchema.optional(),
    category: issueCategorySchema.optional(),
    subtype: issueSubtypeSchema.optional(),
  })
  .strict()
  .superRefine((issue, context) => {
    if (issue.nature === "maintainability-advisory") {
      if (issue.category !== "maintainability") {
        context.addIssue({
          code: "custom",
          path: ["category"],
          message: "a maintainability advisory must use the maintainability category",
        })
      }
      if (issue.severity === "critical" || issue.severity === "high") {
        context.addIssue({
          code: "custom",
          path: ["severity"],
          message: "a maintainability advisory cannot be blocking",
        })
      }
    }
    if (issue.category === "maintainability" && issue.nature === "behavioral-defect") {
      context.addIssue({
        code: "custom",
        path: ["nature"],
        message: "the maintainability category must be recorded as an advisory",
      })
    }
    if (issue.subtype && issue.category !== "maintainability") {
      context.addIssue({
        code: "custom",
        path: ["subtype"],
        message: "duplication and non-idiomatic Go are maintainability subtypes",
      })
    }
    if (issue.subtype === "non-idiomatic-go" && issue.severity !== "low") {
      context.addIssue({
        code: "custom",
        path: ["severity"],
        message: "a non-idiomatic Go advisory must use low severity",
      })
    }
  })

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
    origin: exampleOriginSchema.optional(),
    split: exampleSplitSchema.optional(),
    versionRole: versionRoleSchema.optional(),
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
          evalCase.origin !== first.origin ||
          evalCase.split !== first.split ||
          !isDeepStrictEqual(evalCase.context, first.context)
        ) {
          context.addIssue({
            code: "custom",
            path: ["cases", index, "seedId"],
            message: `versions in ${seedId} must share their repository, pull request, base commit, and context`,
          })
        }
      }

      if (first.origin === "synthetic") {
        const roles = cases.map(({ evalCase }) => evalCase.versionRole)
        if (
          roles.filter((role) => role === "baseline").length !== 1 ||
          roles.filter((role) => role === "introduced-issue").length !== 1
        ) {
          context.addIssue({
            code: "custom",
            path: ["cases", cases[0]!.index, "versionRole"],
            message: `synthetic seed ${seedId} must have one baseline and one introduced-issue version`,
          })
        }
      }
    }
  })

const judgementProvenanceSchema = z.object({
  provider: z.enum(["amp", "typesafe", "jev-cascade"]).optional(),
  version: z.string(),
  mode: z.string(),
  model: z.string().optional(),
  sdkVersion: z.string(),
  cliVersion: z.string().optional(),
  project: z.string().nullable(),
  apiVersion: z.string().optional(),
  threshold: z.number().min(0).max(1).optional(),
  prompt: z.string().optional(),
  responseSchema: z.string().optional(),
  promptHash: z.string(),
  schemaHash: z.string(),
}).strict()

const cascadePairSchema = z.object({
  findingIndex: z.number().int().nonnegative(),
  pathEqual: z.boolean(),
  lineOverlap: z.boolean(),
  requestHash: z.string(),
  route: z.enum(["match", "non-match", "escalate"]),
  reason: z.string(),
  relation: z.object({
    "0": z.number().min(0).max(1),
    "1": z.number().min(0).max(1),
    "2": z.number().min(0).max(1),
  }).strict().optional(),
  sameCause: z.number().min(0).max(1).optional(),
  sameFailure: z.number().min(0).max(1).optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).strict().optional(),
  durationMs: z.number().int().nonnegative(),
  cacheHit: z.boolean(),
  error: z.string().optional(),
}).strict()

const judgementFields = {
  issueId: z.string().min(1),
  matchingFindingIndices: z.array(z.number().int().nonnegative()),
  votes: z.array(z.array(z.number().int().nonnegative())).min(1).max(3),
  disagreement: z.boolean(),
  models: z.array(z.string()),
  probabilities: z.array(z.number().min(0).max(1)).optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .strict()
    .optional(),
  provenance: judgementProvenanceSchema,
  cascade: z.object({
    issueRoute: z.enum(["jev", "amp-fallback"]),
    issueReason: z.string(),
    pairs: z.array(cascadePairSchema),
    ampVotesAvoided: z.number().int().nonnegative(),
    ampDurationMs: z.number().int().nonnegative().optional(),
    ampProvenance: judgementProvenanceSchema.optional(),
  }).strict().optional(),
}

const judgementSchema = z.object(judgementFields).strict().superRefine((judgement, context) => {
  if (judgement.provenance.provider === "typesafe" ||
      (judgement.provenance.provider === "jev-cascade" && judgement.cascade?.issueRoute === "jev")) {
    if (judgement.votes.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["votes"],
        message: "TypeSafe judgements must record one thresholded decision",
      })
    }
  } else if (judgement.votes.length < 2) {
    context.addIssue({
      code: "custom",
      path: ["votes"],
      message: "Amp judgements must record at least two votes",
    })
  }
  if ((judgement.provenance.provider === "jev-cascade") !== (judgement.cascade !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["cascade"],
      message: "Jev cascade provenance and audit data must be recorded together",
    })
  }
})

/**
 * What Amp billed for the thread that produced the review, as reported by
 * `amp threads usage`. Unlike the trace, this includes subagent threads.
 * `costUsd` is Amp credits only; it is 0 when a subscription covered the
 * inference, which `subscriptionUsed` records. The estimated provider list
 * price is absent when the CLI does not report it.
 */
export const threadUsageSchema = z
  .object({
    costUsd: z.number().nonnegative(),
    estimatedProviderCostAtListPriceUsd: z.number().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    subscriptionUsed: z.boolean(),
  })
  .strict()
export type ThreadUsage = z.infer<typeof threadUsageSchema>

const sampleFields = {
  caseId: z.string(),
  sample: z.number().int().positive(),
  expected: expectedSchema,
  promptHash: z.string(),
  prompt: z.string().optional(),
  sourceSetupPromptHash: z.string().optional(),
  sourceSetupPrompt: z.string().optional(),
  threadId: z.string().nullable(),
  models: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
  reviewDurationMs: z.number().int().nonnegative().optional(),
  matchingDurationMs: z.number().int().nonnegative().optional(),
  trace: z.array(z.unknown()).optional(),
  /** How many times Amp was run again for this review; absent when the reviewer never reported. */
  retries: z.number().int().nonnegative().optional(),
  evidenceBoundaryViolations: z.array(z.string().min(1)).optional(),
  usage: threadUsageSchema.optional(),
  /** Why `usage` is missing, when the lookup ran: Amp's explanation or the lookup error. */
  usageUnavailable: z.string().min(1).optional(),
}

/**
 * The second look at a review's blocking findings, run after the review in a
 * fresh thread. When it completed, `retainedResult` carries its ratings and
 * `conclusion` follows them; when it failed, the review's own severities stand.
 */
const severityRepassFields = {
  promptHash: z.string(),
  prompt: z.string(),
  threadId: z.string().nullable(),
  models: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative().optional(),
  trace: z.array(z.unknown()).optional(),
  evidenceBoundaryViolations: z.array(z.string().min(1)),
}
const severityRepassSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...severityRepassFields,
      status: z.literal("completed"),
      rawResult: z.string(),
      ratings: severityRepassResultSchema.shape.ratings,
      // A re-pass that broke the review rules is saved as an error, so its
      // ratings never reach a decision page that does not re-check traces.
      evidenceBoundaryViolations: z.array(z.string().min(1)).max(0),
    })
    .strict(),
  z.object({ ...severityRepassFields, status: z.literal("error"), error: z.string() }).strict(),
])
export type SeverityRepass = z.infer<typeof severityRepassSchema>

const completedSampleSchema = z
  .object({
    ...sampleFields,
    status: z.literal("completed"),
    rawResult: z.string(),
    parsedResult: reviewResultSchema,
    retainedResult: reviewResultSchema,
    omitted: z.number().int().nonnegative(),
    conclusion: conclusionSchema,
    severityRepass: severityRepassSchema.optional(),
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

const reviewAccountSchema = z.union([
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
])
export type ReviewAccount = z.infer<typeof reviewAccountSchema>

export const evalRunSchema = z
  .object({
    schemaVersion: z.union([z.literal(2), z.literal(3)]),
    corpusVersion: z.string(),
    corpusHash: artifactHashSchema,
    startedAt: z.string(),
    completedAt: z.string(),
    requestedSamplesPerCase: z.number().int().positive(),
    concurrency: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    judgeTimeoutMs: z.number().int().positive().optional(),
    reviewsCompletedAt: z.string().optional(),
    orderSeed: z.string().min(1).optional(),
    executionOrder: z
      .array(
        z
          .object({
            caseId: z.string().min(1),
            sample: z.number().int().positive(),
          })
          .strict(),
      )
      .optional(),
    finishedFrom: z
      .object({
        sourceArtifactHash: artifactHashSchema,
        finishedAt: z.string(),
      })
      .strict()
      .optional(),
    rescoredFrom: z
      .object({
        sourceArtifactHash: artifactHashSchema,
        sourceCorpusVersion: z.string(),
        packVersion: z.string(),
        rescoredAt: z.string(),
        dropped: z.array(rescoreDropSchema),
      })
      .strict()
      .optional(),
    /** Set when the saved reviews were re-used and only their blocking findings were re-rated. */
    repassedFrom: z
      .object({
        sourceArtifactHash: artifactHashSchema,
        repassedAt: z.string(),
        /** The re-pass prompt's identifier, like a prompt variant's: name@hash. */
        prompt: z.string().min(1),
        mode: z.string().min(1),
        model: z.string().optional(),
        /** The account that ran the re-pass threads; it may differ from the review's. */
        account: reviewAccountSchema,
        attempted: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    reviewer: z.object({
      gitCommit: z.string(),
      dirty: z.boolean(),
      sdkVersion: z.string(),
      cliVersion: z.string().optional(),
      mode: z.enum(["medium", "reviewbot-v1"]),
      model: z.string().optional(),
      failOn: z.literal("high"),
      reviewSourceHash: z.string(),
      methodologyHash: z.string(),
      project: z.string().min(1).nullable(),
      protocol: z
        .enum([
          "research-enabled-target-frozen",
          "research-enabled-target-frozen-v2",
          "research-enabled-target-frozen-v3",
          "research-enabled-target-frozen-v4",
          "research-enabled-target-frozen-v5",
        ])
        .optional(),
      account: reviewAccountSchema,
    }),
    cases: z.array(evalCaseSchema).min(1),
    samples: z.array(evalSampleSchema).min(1),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.reviewer.protocol?.startsWith("research-enabled-target-frozen")) {
      if (run.schemaVersion !== 3) {
        context.addIssue({
          code: "custom",
          path: ["schemaVersion"],
          message: "this evaluation requires schema version 3 evidence",
        })
      }
      if (run.reviewer.project !== null) {
        context.addIssue({
          code: "custom",
          path: ["reviewer", "project"],
          message: "this evaluation requires a reviewer with no Amp project",
        })
      }
      if (
        (run.reviewer.protocol === "research-enabled-target-frozen-v2" ||
          run.reviewer.protocol === "research-enabled-target-frozen-v3" ||
          run.reviewer.protocol === "research-enabled-target-frozen-v4" ||
          run.reviewer.protocol === "research-enabled-target-frozen-v5") &&
        run.reviewer.cliVersion === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["reviewer", "cliVersion"],
          message: "this evaluation requires the exact Amp CLI version",
        })
      }
      if (
        (run.reviewer.protocol === "research-enabled-target-frozen-v3" ||
          run.reviewer.protocol === "research-enabled-target-frozen-v4" ||
          run.reviewer.protocol === "research-enabled-target-frozen-v5") &&
        (run.reviewer.mode !== "reviewbot-v1" ||
          run.reviewer.model !== "openai/gpt-5.6-sol")
      ) {
        context.addIssue({
          code: "custom",
          path: ["reviewer"],
          message: "this evaluation requires the pinned review mode and model",
        })
      }
      if (
        !("authentication" in run.reviewer.account) ||
        run.reviewer.account.authentication !== "reviewer-api-key"
      ) {
        context.addIssue({
          code: "custom",
          path: ["reviewer", "account"],
          message: "this evaluation requires a separate reviewer API key",
        })
      }
    }
    if (run.schemaVersion === 3) {
      for (const field of ["judgeTimeoutMs", "reviewsCompletedAt", "orderSeed", "executionOrder"] as const) {
        if (run[field] === undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `schema version 3 requires ${field}`,
          })
        }
      }
      if (run.executionOrder?.length !== run.samples.length) {
        context.addIssue({
          code: "custom",
          path: ["executionOrder"],
          message: "execution order must record every review sample",
        })
      } else {
        run.executionOrder?.forEach((task, index) => {
          const sample = run.samples[index]
          if (sample && (task.caseId !== sample.caseId || task.sample !== sample.sample)) {
            context.addIssue({
              code: "custom",
              path: ["executionOrder", index],
              message: "execution order must match the saved sample order",
            })
          }
        })
      }
    }

    const expectedCorpusHash = corpusContentHash({
      version: run.corpusVersion,
      cases: run.cases,
    })
    if (run.corpusHash !== expectedCorpusHash) {
      context.addIssue({
        code: "custom",
        path: ["corpusHash"],
        message: "example data hash does not match the embedded cases",
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
          message: "sample expectation does not match its example",
        })
      }
      if (sample.status === "completed") {
        validateCompletedSample(sample, evalCase, index, context)
      }
      if (
        run.schemaVersion === 3 &&
        (sample.prompt === undefined ||
          sample.trace === undefined ||
          sample.reviewDurationMs === undefined ||
          sample.matchingDurationMs === undefined ||
          sample.evidenceBoundaryViolations === undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["samples", index],
          message: "schema version 3 requires the full prompt, trace, phase timings, and trace check",
        })
      }
      if (run.schemaVersion === 3 && sample.prompt !== undefined) {
        const expectedPromptHash = createHash("sha256").update(sample.prompt).digest("hex")
        if (sample.promptHash !== expectedPromptHash) {
          context.addIssue({
            code: "custom",
            path: ["samples", index, "promptHash"],
            message: "prompt hash does not match the saved full prompt",
          })
        }
        if (
          run.reviewer.protocol === "research-enabled-target-frozen-v4" &&
          (sample.sourceSetupPrompt === undefined || sample.sourceSetupPromptHash === undefined)
        ) {
          context.addIssue({
            code: "custom",
            path: ["samples", index, "sourceSetupPrompt"],
            message: "this evaluation requires the full source setup prompt and its hash",
          })
        } else if (
          sample.sourceSetupPrompt !== undefined &&
          sample.sourceSetupPromptHash !==
            createHash("sha256").update(sample.sourceSetupPrompt).digest("hex")
        ) {
          context.addIssue({
            code: "custom",
            path: ["samples", index, "sourceSetupPromptHash"],
            message: "source setup prompt hash does not match the saved full prompt",
          })
        }
        if (
          run.reviewer.protocol === "research-enabled-target-frozen-v5" &&
          !/^<reviewbot-source-setup-v1>\n[\s\S]+?\n<\/reviewbot-source-setup-v1>\n\n/.test(
            sample.prompt,
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["samples", index, "prompt"],
            message: "this evaluation prompt must start with its source setup block",
          })
        }
        if (
          sample.reviewDurationMs !== undefined &&
          sample.matchingDurationMs !== undefined &&
          sample.durationMs !== sample.reviewDurationMs + sample.matchingDurationMs
        ) {
          context.addIssue({
            code: "custom",
            path: ["samples", index, "durationMs"],
            message: "sample duration must equal its review and matching phase durations",
          })
        }
        if (sample.status === "completed") {
          sample.judgements.forEach((judgement, judgementIndex) => {
            const provenance = judgement.provenance
            if (
              (run.reviewer.protocol === "research-enabled-target-frozen-v2" ||
                run.reviewer.protocol === "research-enabled-target-frozen-v3" ||
                run.reviewer.protocol === "research-enabled-target-frozen-v4" ||
                run.reviewer.protocol === "research-enabled-target-frozen-v5") &&
              provenance.provider !== "typesafe" &&
              provenance.cliVersion === undefined
            ) {
              context.addIssue({
                code: "custom",
                path: ["samples", index, "judgements", judgementIndex, "provenance", "cliVersion"],
                message: "this evaluation requires the Amp CLI version for each judgement",
              })
            }
            if (
              (run.reviewer.protocol === "research-enabled-target-frozen-v3" ||
                run.reviewer.protocol === "research-enabled-target-frozen-v4" ||
                run.reviewer.protocol === "research-enabled-target-frozen-v5") &&
              provenance.provider !== "typesafe" &&
              provenance.provider !== "jev-cascade" &&
              (provenance.mode !== "reviewbot-judge-v1" ||
                provenance.model !== "openai/gpt-5.6-sol")
            ) {
              context.addIssue({
                code: "custom",
                path: ["samples", index, "judgements", judgementIndex, "provenance", "model"],
                message: "this evaluation requires the pinned finding-check mode and model",
              })
            }
            if (provenance.prompt === undefined || provenance.responseSchema === undefined) {
              context.addIssue({
                code: "custom",
                path: ["samples", index, "judgements", judgementIndex, "provenance"],
                message: "schema version 3 requires each judgement's full prompt and response schema",
              })
              return
            }
            if (
              provenance.promptHash !==
              createHash("sha256").update(provenance.prompt).digest("hex")
            ) {
              context.addIssue({
                code: "custom",
                path: ["samples", index, "judgements", judgementIndex, "provenance", "promptHash"],
                message: "judgement prompt hash does not match the saved full prompt",
              })
            }
            if (
              provenance.schemaHash !==
              createHash("sha256").update(provenance.responseSchema).digest("hex")
            ) {
              context.addIssue({
                code: "custom",
                path: ["samples", index, "judgements", judgementIndex, "provenance", "schemaHash"],
                message: "judgement schema hash does not match the saved response schema",
              })
            }
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
  let finalized: ReturnType<typeof finalizeReview> | undefined
  let parsedResult: ReturnType<typeof parseReviewResult> | undefined
  try {
    parsedResult = parseReviewResult(sample.rawResult)
    finalized = finalizeReview(parsedResult, changedLineMap(evalCase), "high")
  } catch {
    context.addIssue({
      code: "custom",
      path: ["samples", sampleIndex, "rawResult"],
      message: "raw result is not valid review JSON",
    })
  }
  if (finalized && parsedResult) {
    let retained = finalized.result
    if (sample.severityRepass?.status === "completed") {
      // The raw re-pass output is the evidence: the saved ratings must be
      // exactly what it said about exactly the findings that blocked.
      let ratings: ReturnType<typeof parseSeverityRepassResult> | undefined
      try {
        ratings = parseSeverityRepassResult(
          sample.severityRepass.rawResult,
          blockingFindingIndices(finalized.result, "high"),
        )
      } catch {
        context.addIssue({
          code: "custom",
          path: ["samples", sampleIndex, "severityRepass", "rawResult"],
          message: "severity re-pass raw result is not a valid rating of the blocking findings",
        })
      }
      if (ratings && !isDeepStrictEqual(sample.severityRepass.ratings, ratings)) {
        context.addIssue({
          code: "custom",
          path: ["samples", sampleIndex, "severityRepass", "ratings"],
          message: "severity re-pass ratings do not match its raw result",
        })
      }
      if (ratings) retained = applySeverityRatings(finalized.result, ratings)
    }
    const consistent =
      isDeepStrictEqual(sample.parsedResult, parsedResult) &&
      isDeepStrictEqual(sample.retainedResult, retained) &&
      sample.omitted === finalized.omitted &&
      sample.conclusion === checkConclusion(retained, "high")
    if (!consistent) {
      context.addIssue({
        code: "custom",
        path: ["samples", sampleIndex],
        message: "sample result does not match its raw production review",
      })
    }
  }
  if (sample.severityRepass !== undefined) {
    const expectedPromptHash = createHash("sha256").update(sample.severityRepass.prompt).digest("hex")
    if (sample.severityRepass.promptHash !== expectedPromptHash) {
      context.addIssue({
        code: "custom",
        path: ["samples", sampleIndex, "severityRepass", "promptHash"],
        message: "severity re-pass prompt hash does not match its saved prompt",
      })
    }
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
    if (judgement.provenance.provider === "typesafe") {
      const threshold = judgement.provenance.threshold
      const probabilities = judgement.probabilities
      const expectedMatches = probabilities?.flatMap((probability, findingIndex) =>
        threshold !== undefined && probability >= threshold ? [findingIndex] : [],
      )
      if (
        judgement.provenance.apiVersion === undefined ||
        threshold === undefined ||
        probabilities === undefined ||
        probabilities.length !== findingCount ||
        expectedMatches === undefined ||
        !isDeepStrictEqual(judgement.matchingFindingIndices, expectedMatches) ||
        !isDeepStrictEqual(judgement.votes, [expectedMatches]) ||
        judgement.disagreement
      ) {
        context.addIssue({
          code: "custom",
          path: ["samples", sampleIndex, "judgements", judgementIndex],
          message: "TypeSafe judgement does not match its saved probabilities, threshold, or provenance",
        })
      }
    }
    if (judgement.provenance.provider === "jev-cascade") {
      const cascade = judgement.cascade!
      const expectedIssue = sample.expected.issues.find((issue) => issue.id === judgement.issueId)
      const indices = cascade.pairs.map((pair) => pair.findingIndex)
      const completeIndices = Array.from({ length: findingCount }, (_, index) => index)
      const pairShapeValid = isDeepStrictEqual(indices, completeIndices) && cascade.pairs.every((pair) => {
        const finding = sample.retainedResult.findings[pair.findingIndex]
        if (expectedIssue === undefined || finding === undefined) return false
        const pathEqual = expectedIssue.path === finding.path
        const lineOverlap = pathEqual && expectedIssue.changedLine >= finding.startLine &&
          expectedIssue.changedLine <= (finding.endLine ?? finding.startLine)
        if (pair.pathEqual !== pathEqual || pair.lineOverlap !== lineOverlap) return false
        const hasPrimitives = pair.relation !== undefined &&
          pair.sameCause !== undefined && pair.sameFailure !== undefined && pair.usage !== undefined
        if (!hasPrimitives) return pair.route === "escalate" && pair.error !== undefined
        const expectedRoute = pair.relation!["2"] >= 0.9 && pair.sameCause! >= 0.9 && pair.sameFailure! >= 0.9
          ? "match"
          : pair.relation!["0"] >= 0.9 && (pair.sameCause! <= 0.1 || pair.sameFailure! <= 0.1)
            ? "non-match"
            : "escalate"
        return pair.route === expectedRoute
      })
      const autoMatches = cascade.pairs.flatMap((pair) => pair.route === "match" ? [pair.findingIndex] : [])
      const routeValid = cascade.issueRoute === "jev"
        ? cascade.pairs.every((pair) => pair.route !== "escalate") &&
          isDeepStrictEqual(judgement.matchingFindingIndices, autoMatches) &&
          isDeepStrictEqual(judgement.votes, [autoMatches]) &&
          cascade.ampProvenance === undefined
        : cascade.pairs.some((pair) => pair.route === "escalate") &&
          cascade.ampProvenance !== undefined && judgement.votes.length >= 2
      const usage = cascade.pairs.reduce((total, pair) => ({
        inputTokens: total.inputTokens + (pair.usage?.inputTokens ?? 0),
        outputTokens: total.outputTokens + (pair.usage?.outputTokens ?? 0),
      }), { inputTokens: 0, outputTokens: 0 })
      const usageValid = isDeepStrictEqual(judgement.usage, usage)
      if (!pairShapeValid || !routeValid || !usageValid) {
        context.addIssue({
          code: "custom",
          path: ["samples", sampleIndex, "judgements", judgementIndex, "cascade"],
          message: "Jev cascade judgement does not match its pair routes or whole-issue fallback",
        })
      }
      const ampProvenance = cascade.ampProvenance
      if (ampProvenance !== undefined && (
        ampProvenance.prompt === undefined || ampProvenance.responseSchema === undefined ||
        ampProvenance.promptHash !== createHash("sha256").update(ampProvenance.prompt ?? "").digest("hex") ||
        ampProvenance.schemaHash !== createHash("sha256").update(ampProvenance.responseSchema ?? "").digest("hex")
      )) {
        context.addIssue({
          code: "custom",
          path: ["samples", sampleIndex, "judgements", judgementIndex, "cascade", "ampProvenance"],
          message: "Jev cascade Amp fallback provenance hashes do not match",
        })
      }
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
