import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  noul,
  score,
  TypeSafeClient,
  VERSION as typeSafeSdkVersion,
  type RequestOptions,
  type SystemOneRequest,
} from "@typesafe-ai/sdk"
import { z } from "zod"
import type { ReviewFinding } from "../src/types.js"
import { judgeIssue, type IssueMatcher } from "./judge.js"
import { jevModel, type SystemOne } from "./jev.js"
import type { EvalJudgement, ExpectedIssue } from "./schema.js"

export const jevCascadeMatchThreshold = 0.9
export const jevCascadeNonMatchThreshold = 0.1

const matcherVersion = "jev-cascade-1"
const cacheVersion = 1
const apiVersion = "v1"
const relationCriteria = [
  "Different defects: mechanism or failure differs, including superficially similar symptoms from different defects.",
  "Related but unresolved: overlap or omitted identifying detail means equivalence is not established.",
  "Same defect: finding identifies the recorded defect and failure; wording, extra detail, and suggested fixes may differ.",
] as const
const sameCauseCriteria = {
  true: "The finding identifies the defect mechanism in expected.rootCause.",
  false: "The finding does not identify the defect mechanism in expected.rootCause.",
}
const sameFailureCriteria = {
  true: "The finding describes the incorrect behavior or consequence in expected.failureBehavior.",
  false: "The finding does not describe the incorrect behavior or consequence in expected.failureBehavior.",
}
const requestDefinition = JSON.stringify({
  state: {
    expected: ["rootCause", "failureBehavior", "path"],
    finding: ["title", "message", "suggestion", "path"],
  },
  questions: { relation: relationCriteria, sameCause: sameCauseCriteria, sameFailure: sameFailureCriteria },
  thresholds: { match: jevCascadeMatchThreshold, nonMatch: jevCascadeNonMatchThreshold },
  fallback: "Any unresolved or unavailable pair falls back to Amp for the complete issue.",
}, null, 2)
const responseSchemaDocument = `{
  "model": "${jevModel}",
  "answers": {
    "relation": { "type": "score", "probabilities": { "0": "number", "1": "number", "2": "number" } },
    "sameCause": { "type": "noul", "noul": "number" },
    "sameFailure": { "type": "noul", "noul": "number" }
  },
  "usage": { "input_tokens": "non-negative integer", "output_tokens": "non-negative integer" }
}`
const inFlightRequests = new Map<string, Promise<void>>()

const probabilitiesSchema = z.object({
  "0": z.number().min(0).max(1),
  "1": z.number().min(0).max(1),
  "2": z.number().min(0).max(1),
}).strict().refine(
  (probabilities) => Math.abs(
    probabilities["0"] + probabilities["1"] + probabilities["2"] - 1,
  ) <= 0.02,
  "relation probabilities must sum to 1 within rounding tolerance",
)
const pairResultSchema = z.object({
  model: z.literal(jevModel),
  relation: probabilitiesSchema,
  sameCause: z.number().min(0).max(1),
  sameFailure: z.number().min(0).max(1),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).strict(),
  durationMs: z.number().int().nonnegative(),
}).strict()
type PairResult = z.infer<typeof pairResultSchema>

export function createJevCascadeMatcher(
  client = new TypeSafeClient({
    defaultModel: jevModel,
    retry: { maxRetries: 0 },
    timeout: 60_000,
    logLevel: "error",
  }),
  ampMatcher: IssueMatcher = judgeIssue,
): IssueMatcher {
  return (caseId, issue, findings, cacheDirectory, versions, signal) =>
    judgeIssueWithJevCascade(
      caseId,
      issue,
      findings,
      cacheDirectory,
      versions,
      signal,
      client.systemOne.bind(client) as SystemOne,
      ampMatcher,
    )
}

export async function judgeIssueWithJevCascade(
  caseId: string,
  issue: ExpectedIssue,
  findings: ReviewFinding[],
  cacheDirectory: string,
  versions: Parameters<IssueMatcher>[4],
  signal: AbortSignal,
  systemOne: SystemOne,
  ampMatcher: IssueMatcher = judgeIssue,
): Promise<EvalJudgement> {
  const provenance = {
    provider: "jev-cascade" as const,
    version: matcherVersion,
    mode: "system-one-pairwise-with-amp-fallback",
    model: jevModel,
    sdkVersion: typeSafeSdkVersion,
    cliVersion: versions.cliVersion,
    project: null,
    apiVersion,
    prompt: requestDefinition,
    responseSchema: responseSchemaDocument,
    promptHash: hash(requestDefinition),
    schemaHash: hash(responseSchemaDocument),
  }
  if (findings.length === 0) {
    return {
      issueId: issue.id,
      matchingFindingIndices: [],
      votes: [[]],
      disagreement: false,
      models: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      provenance,
      cascade: {
        issueRoute: "jev",
        issueReason: "no-candidate-findings",
        pairs: [],
        ampVotesAvoided: 0,
      },
    }
  }

  const pairs = await Promise.all(findings.map(async (finding, findingIndex) => {
    const started = performance.now()
    const request = jevCascadeRequest(issue, finding)
    const prompt = JSON.stringify(request)
    try {
      const { result, cacheHit } = await cachedPairResult(
        request,
        resolve(cacheDirectory, "jev-cascade"),
        hash(JSON.stringify({
          cacheVersion,
          matcherVersion,
          model: jevModel,
          apiVersion,
          sdkVersion: typeSafeSdkVersion,
          prompt,
          responseSchemaHash: hash(responseSchemaDocument),
        })),
        signal,
        systemOne,
      )
      const decision = routePair(result)
      return {
        findingIndex,
        pathEqual: issue.path === finding.path,
        lineOverlap: issue.path === finding.path &&
          issue.changedLine >= finding.startLine &&
          issue.changedLine <= (finding.endLine ?? finding.startLine),
        requestHash: hash(prompt),
        route: decision.route,
        reason: decision.reason,
        relation: result.relation,
        sameCause: result.sameCause,
        sameFailure: result.sameFailure,
        usage: result.usage,
        durationMs: result.durationMs,
        cacheHit,
      }
    } catch (error) {
      if (signal.aborted) throw error
      return {
        findingIndex,
        pathEqual: issue.path === finding.path,
        lineOverlap: issue.path === finding.path &&
          issue.changedLine >= finding.startLine &&
          issue.changedLine <= (finding.endLine ?? finding.startLine),
        requestHash: hash(prompt),
        route: "escalate" as const,
        reason: "invalid-or-unavailable-response",
        error: errorMessage(error),
        durationMs: Math.round(performance.now() - started),
        cacheHit: false,
      }
    }
  }))
  const unresolvedPairs = pairs.filter((pair) => pair.route === "escalate")
  const unresolved = unresolvedPairs.find((pair) => pair.reason === "invalid-or-unavailable-response") ??
    unresolvedPairs[0]
  const jevUsage = pairs.reduce(
    (usage, pair) => ({
      inputTokens: usage.inputTokens + (pair.usage?.inputTokens ?? 0),
      outputTokens: usage.outputTokens + (pair.usage?.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  )
  if (unresolved) {
    const ampStarted = performance.now()
    const amp = await ampMatcher(caseId, issue, findings, cacheDirectory, versions, signal)
    const ampDurationMs = Math.round(performance.now() - ampStarted)
    return {
      ...amp,
      models: [...new Set([...pairs.flatMap((pair) => pair.relation === undefined ? [] : [jevModel]), ...amp.models])],
      usage: jevUsage,
      provenance,
      cascade: {
        issueRoute: "amp-fallback",
        issueReason: unresolved.reason,
        pairs,
        ampVotesAvoided: 0,
        ampDurationMs,
        ampProvenance: amp.provenance,
      },
    }
  }

  const matchingFindingIndices = pairs.flatMap((pair) =>
    pair.route === "match" ? [pair.findingIndex] : [],
  )
  return {
    issueId: issue.id,
    matchingFindingIndices,
    votes: [matchingFindingIndices],
    disagreement: false,
    models: [jevModel],
    usage: jevUsage,
    provenance,
    cascade: {
      issueRoute: "jev",
      issueReason: "all-pairs-decisive",
      pairs,
      // The incumbent always requires two votes and sometimes three. This is
      // the conservative number actually avoided, not a cost projection.
      ampVotesAvoided: 2,
    },
  }
}

export function jevCascadeRequest(
  expected: ExpectedIssue,
  finding: ReviewFinding,
): SystemOneRequest {
  const expectedPath = tick(expected.path)
  const findingPath = tick(finding.path)
  return {
    model: jevModel,
    state: {
      expected: {
        rootCause: expected.rootCause,
        failureBehavior: expected.failureBehavior,
        path: expected.path,
      },
      finding: {
        title: finding.title,
        message: finding.message,
        suggestion: finding.suggestion,
        path: finding.path,
      },
    },
    questions: {
      relation: score(
        `How does the defect described by finding.title, finding.message, and finding.suggestion at ${findingPath} relate to expected.rootCause and expected.failureBehavior at ${expectedPath}? Suggested fixes need not agree.`,
        relationCriteria,
      ),
      sameCause: noul(
        `Does the defect described by finding.title, finding.message, and finding.suggestion at ${findingPath} identify the defect mechanism in expected.rootCause at ${expectedPath}? Suggested fixes need not agree.`,
        sameCauseCriteria,
      ),
      sameFailure: noul(
        `Does the defect described by finding.title, finding.message, and finding.suggestion at ${findingPath} describe the incorrect behavior or consequence in expected.failureBehavior at ${expectedPath}? Suggested fixes need not agree.`,
        sameFailureCriteria,
      ),
    },
  }
}

export function routeJevCascadePair(
  relation: { "0": number; "1": number; "2": number },
  sameCause: number,
  sameFailure: number,
): { route: "match" | "non-match" | "escalate"; reason: string } {
  if (
    relation["2"] >= jevCascadeMatchThreshold &&
    sameCause >= jevCascadeMatchThreshold &&
    sameFailure >= jevCascadeMatchThreshold
  ) return { route: "match", reason: "all-match-thresholds-met" }
  if (
    relation["0"] >= jevCascadeMatchThreshold &&
    (sameCause <= jevCascadeNonMatchThreshold || sameFailure <= jevCascadeNonMatchThreshold)
  ) {
    const reason = sameCause <= jevCascadeNonMatchThreshold && sameFailure <= jevCascadeNonMatchThreshold
      ? "different-and-both-component-nonmatch-thresholds-met"
      : sameCause <= jevCascadeNonMatchThreshold
        ? "different-and-cause-nonmatch-threshold-met"
        : "different-and-failure-nonmatch-threshold-met"
    return { route: "non-match", reason }
  }
  return { route: "escalate", reason: "selective-thresholds-unresolved" }
}

function routePair(result: PairResult) {
  return routeJevCascadePair(result.relation, result.sameCause, result.sameFailure)
}

async function cachedPairResult(
  request: SystemOneRequest,
  cacheDirectory: string,
  cacheKey: string,
  signal: AbortSignal,
  systemOne: SystemOne,
): Promise<{ result: PairResult; cacheHit: boolean }> {
  const cachePath = resolve(cacheDirectory, `${cacheKey}.json`)
  for (;;) {
    const pending = inFlightRequests.get(cachePath)
    if (pending) {
      await pending
      signal.throwIfAborted()
      continue
    }
    let release!: () => void
    const slot = new Promise<void>((done) => { release = done })
    inFlightRequests.set(cachePath, slot)
    try {
      return await readOrCreatePairResult(request, cacheDirectory, cachePath, signal, systemOne)
    } finally {
      if (inFlightRequests.get(cachePath) === slot) inFlightRequests.delete(cachePath)
      release()
    }
  }
}

async function readOrCreatePairResult(
  request: SystemOneRequest,
  cacheDirectory: string,
  cachePath: string,
  signal: AbortSignal,
  systemOne: SystemOne,
): Promise<{ result: PairResult; cacheHit: boolean }> {
  signal.throwIfAborted()
  try {
    const result = pairResultSchema.parse(JSON.parse(await readFile(cachePath, "utf8")))
    signal.throwIfAborted()
    return { result, cacheHit: true }
  } catch (error) {
    if (!isMissingFile(error)) await unlink(cachePath).catch(() => {})
  }
  const started = performance.now()
  const response = await systemOne(request, { signal } satisfies RequestOptions)
  signal.throwIfAborted()
  const parsed = z.object({
    model: z.literal(jevModel),
    answers: z.object({
      relation: z.object({
        type: z.literal("score"),
        score: z.number().min(0).max(2),
        confidence: z.number().min(0).max(1),
        legend: z.object({ "0": z.unknown(), "1": z.unknown(), "2": z.unknown() }).strict(),
        probabilities: probabilitiesSchema,
      }).strict(),
      sameCause: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).strict(),
      sameFailure: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).strict(),
    }).strict(),
    usage: z.object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    }).strict(),
  }).passthrough().parse(response)
  const result = pairResultSchema.parse({
    model: parsed.model,
    relation: parsed.answers.relation.probabilities,
    sameCause: parsed.answers.sameCause.noul,
    sameFailure: parsed.answers.sameFailure.noul,
    usage: {
      inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens,
    },
    durationMs: Math.round(performance.now() - started),
  })
  await mkdir(cacheDirectory, { recursive: true })
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryPath, cachePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
  signal.throwIfAborted()
  return { result, cacheHit: false }
}

function tick(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
