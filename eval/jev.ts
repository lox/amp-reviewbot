import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  noul,
  TypeSafeClient,
  VERSION as typeSafeSdkVersion,
  type Questions,
  type RequestOptions,
  type SystemOneRequest,
} from "@typesafe-ai/sdk"
import { z } from "zod"
import type { ReviewFinding } from "../src/types.js"
import type { IssueMatcher } from "./judge.js"
import type { EvalJudgement, ExpectedIssue } from "./schema.js"

export const jevModel = "jev-1.13.0"
export const jevMatchThreshold = 0.8

const matcherVersion = "jev-1"
const provider = "typesafe" as const
const apiVersion = "v1"
const responseSchemaDocument = `{
  "model": "${jevModel}",
  "answers": {
    "finding_<zero-based index>": {
      "type": "noul",
      "noul": "number from 0 through 1: probability that the finding matches"
    }
  }
}`
const responseSchemaHash = hash(responseSchemaDocument)
const questionDefinition = {
  question: "Does this candidate review finding describe the same underlying issue as the recorded expected issue?",
  matchRule: "Answer yes only when both the root cause and resulting failure behavior are the same. Wording and suggested fixes may differ. Merely sharing a file, symbol, or general topic is not a match.",
}
const criteria = {
  true: "The candidate finding has the same root cause and failure behavior as the expected issue.",
  false: "The root cause or failure behavior differs, or the candidate only overlaps in location or topic.",
}
const inFlightRequests = new Map<string, Promise<void>>()

export type SystemOne = (
  request: SystemOneRequest,
  options?: RequestOptions,
) => PromiseLike<unknown>

const answerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
}).strict()

const cachedResultSchema = z.object({
  model: z.literal(jevModel),
  probabilities: z.array(z.number().min(0).max(1)),
}).strict()

export function createJevMatcher(
  threshold = jevMatchThreshold,
  client = new TypeSafeClient(),
): IssueMatcher {
  validateThreshold(threshold)
  return (caseId, issue, findings, cacheDirectory, _versions, signal) =>
    judgeIssueWithJev(
      caseId,
      issue,
      findings,
      cacheDirectory,
      signal,
      threshold,
      client.systemOne.bind(client) as SystemOne,
    )
}

export async function judgeIssueWithJev(
  _caseId: string,
  issue: ExpectedIssue,
  findings: ReviewFinding[],
  cacheDirectory: string,
  signal: AbortSignal,
  threshold = jevMatchThreshold,
  systemOne: SystemOne = (request, options) => new TypeSafeClient().systemOne(request, options),
): Promise<EvalJudgement> {
  validateThreshold(threshold)
  const request = jevRequest(issue, findings)
  const prompt = JSON.stringify(request, null, 2)
  const provenance = {
    provider,
    version: matcherVersion,
    mode: "system-one",
    model: jevModel,
    sdkVersion: typeSafeSdkVersion,
    project: null,
    apiVersion,
    threshold,
    prompt,
    responseSchema: responseSchemaDocument,
    promptHash: hash(prompt),
    schemaHash: responseSchemaHash,
  }

  if (findings.length === 0) {
    return {
      issueId: issue.id,
      matchingFindingIndices: [],
      votes: [[]],
      disagreement: false,
      models: [],
      probabilities: [],
      provenance,
    }
  }

  const cacheKey = hash(JSON.stringify({
    provider,
    apiVersion,
    matcherVersion,
    model: jevModel,
    sdkVersion: typeSafeSdkVersion,
    threshold,
    prompt,
    responseSchemaHash,
  }))
  const result = await cachedJevResult(
    request,
    findings.length,
    cacheDirectory,
    cacheKey,
    signal,
    systemOne,
  )
  const matchingFindingIndices = result.probabilities.flatMap((probability, index) =>
    probability >= threshold ? [index] : [],
  )
  return {
    issueId: issue.id,
    matchingFindingIndices,
    votes: [matchingFindingIndices],
    disagreement: false,
    models: [result.model],
    probabilities: result.probabilities,
    provenance,
  }
}

function jevRequest(issue: ExpectedIssue, findings: ReviewFinding[]): SystemOneRequest<Questions> {
  const questions = Object.fromEntries(findings.map((_, index) => [
    questionId(index),
    noul(
      { ...questionDefinition, candidateFindingIndex: index },
      criteria,
    ),
  ]))
  return {
    model: jevModel,
    state: JSON.stringify({ expectedIssue: issue, candidateFindings: findings }),
    questions,
  }
}

async function cachedJevResult(
  request: SystemOneRequest,
  findingCount: number,
  cacheDirectory: string,
  cacheKey: string,
  signal: AbortSignal,
  systemOne: SystemOne,
): Promise<z.infer<typeof cachedResultSchema>> {
  const cachePath = resolve(cacheDirectory, `${cacheKey}.json`)
  for (;;) {
    const pending = inFlightRequests.get(cachePath)
    if (pending) {
      await waitForSlot(pending, signal)
      continue
    }

    let release!: () => void
    const slot = new Promise<void>((resolveSlot) => {
      release = resolveSlot
    })
    inFlightRequests.set(cachePath, slot)
    try {
      return await readOrCreateJevResult(
        request,
        findingCount,
        cacheDirectory,
        cachePath,
        signal,
        systemOne,
      )
    } finally {
      if (inFlightRequests.get(cachePath) === slot) inFlightRequests.delete(cachePath)
      release()
    }
  }
}

async function readOrCreateJevResult(
  request: SystemOneRequest,
  findingCount: number,
  cacheDirectory: string,
  cachePath: string,
  signal: AbortSignal,
  systemOne: SystemOne,
): Promise<z.infer<typeof cachedResultSchema>> {
  signal.throwIfAborted()
  try {
    const cached = cachedResultSchema.extend({
      probabilities: z.array(z.number().min(0).max(1)).length(findingCount),
    }).parse(JSON.parse(await readFile(cachePath, "utf8")))
    signal.throwIfAborted()
    return cached
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  const response = await systemOne(request, { signal })
  signal.throwIfAborted()
  const answerShape: Record<string, typeof answerSchema> = {}
  for (let index = 0; index < findingCount; index += 1) answerShape[questionId(index)] = answerSchema
  const parsed = z.object({
    model: z.literal(jevModel),
    answers: z.object(answerShape).strict(),
  }).passthrough().parse(response)
  const result = cachedResultSchema.parse({
    model: parsed.model,
    probabilities: Array.from(
      { length: findingCount },
      (_, index) => parsed.answers[questionId(index)]!.noul,
    ),
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
  return result
}

function questionId(index: number): string {
  return `finding_${index}`
}

function validateThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Jev match threshold must be a number from 0 through 1")
  }
}

function waitForSlot(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolveWait, rejectWait) => {
    const aborted = () => {
      cleanup()
      rejectWait(signal.reason)
    }
    const cleanup = () => signal.removeEventListener("abort", aborted)
    signal.addEventListener("abort", aborted, { once: true })
    void pending.then(() => {
      cleanup()
      resolveWait()
    })
  })
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
