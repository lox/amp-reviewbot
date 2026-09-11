import { createHash } from "node:crypto"
import { pinnedModel, reviewMode } from "../src/amp.js"
import {
  applySeverityRatings,
  blockingFindingIndices,
  buildSeverityRepassPrompt,
  buildSourceSetupPrompt,
  checkConclusion,
  parseSeverityRepassResult,
  reviewThreadTitle,
} from "../src/review.js"
import type { ReviewFinding, ReviewJob, Severity } from "../src/types.js"
import { checkReviewTrace, modelsFromTrace } from "./evidence.js"
import type { LoadedPack } from "./pack.js"
import { runEvaluationReview, type EvaluationReviewInput } from "./reviewer.js"
import {
  evalRunSchema,
  type EvalCase,
  type EvalRun,
  type EvalSample,
  type ReviewAccount,
  type SeverityRepass,
} from "./schema.js"

const failOn: Severity = "high"

type RunRepassReview = (input: EvaluationReviewInput) => ReturnType<typeof runEvaluationReview>

export type RepassOptions = {
  reviewerApiKey?: string
  /** The verified identity behind `reviewerApiKey`, recorded with the run. */
  account: ReviewAccount
  timeoutMs: number
  concurrency: number
  repassedAt: string
}

export type RepassChange = {
  caseId: string
  before: "BLOCK" | "PASS"
  after: "BLOCK" | "PASS"
  /** Findings whose severity the re-pass lowered: title with old and new severity. */
  lowered: Array<{ title: string; path: string; startLine: number; from: Severity; to: Severity }>
}

export type RepassResult = {
  run: EvalRun
  attempted: number
  failed: number
  changes: RepassChange[]
  evidenceBoundaryViolations: number
}

export type RepassProgress = (
  finished: number,
  total: number,
  caseId: string,
  outcome: "completed" | "did not complete",
  durationMs: number,
) => void

/** The re-pass prompt's identifier, built like a prompt variant's from a fixed job and finding. */
export function severityRepassIdentifier(): string {
  const job = identifyingJob()
  const finding: ReviewFinding = {
    severity: failOn,
    title: "identifier",
    message: "identifier",
    suggestion: "identifier",
    path: "identifier",
    startLine: 1,
  }
  const prompt = buildSeverityRepassPrompt(job, { findings: [finding] }, [0], { failOn, preparedSource: true })
  return `severity-repass@${hash(prompt).slice(0, 12)}`
}

/**
 * Re-rates the blocking findings of every completed review in `sourceRun` that
 * blocked, in a fresh thread per review with the same prepared source, and
 * returns the run those ratings imply. Reviews that did not block are left as
 * they are: the re-pass can only lower severities, so it cannot change them.
 */
export async function repassRun(
  sourceRun: EvalRun,
  sourceBytes: Buffer,
  pack: LoadedPack,
  options: RepassOptions,
  runReview: RunRepassReview = runEvaluationReview,
  progress: RepassProgress = () => {},
): Promise<RepassResult> {
  // A second re-pass would rate already-lowered findings and could no longer
  // be checked against the raw review, so start again from the original run.
  if (sourceRun.repassedFrom !== undefined) {
    throw new Error("This run was already re-passed; re-pass the original review artifact instead")
  }
  // The decision page pairs versions by case and would keep one repeat per
  // case, so only single-sample artifacts (every `ab` result) are comparable.
  if (sourceRun.requestedSamplesPerCase !== 1) {
    throw new Error(
      `This run reviewed each version ${sourceRun.requestedSamplesPerCase} times; re-pass an ab artifact or a run with --samples 1`,
    )
  }
  const cases = new Map(sourceRun.cases.map((evalCase) => [evalCase.id, evalCase]))
  const targets = sourceRun.samples.filter(
    (sample): sample is Extract<EvalSample, { status: "completed" }> =>
      sample.status === "completed" && sample.conclusion === "failure",
  )
  for (const sample of targets) {
    if (pack.sourcePreparation.get(sample.caseId) === undefined) {
      throw new Error(`No prepared source for ${sample.caseId}; re-score the run against this pack first`)
    }
  }
  let finished = 0
  const repassed = new Map<string, Extract<EvalSample, { status: "completed" }>>()
  await mapConcurrent(targets, options.concurrency, async (sample) => {
    const evalCase = cases.get(sample.caseId)!
    const sourcePreparation = pack.sourcePreparation.get(sample.caseId)!
    const result = await repassSample(sample, evalCase, sourcePreparation, options, runReview)
    repassed.set(sampleKey(sample), result)
    finished += 1
    progress(
      finished,
      targets.length,
      sample.caseId,
      result.severityRepass?.status === "completed" ? "completed" : "did not complete",
      result.severityRepass?.durationMs ?? 0,
    )
  })

  const samples = sourceRun.samples.map((sample) => repassed.get(sampleKey(sample)) ?? sample)
  const failed = [...repassed.values()].filter((sample) => sample.severityRepass?.status === "error").length
  const changes: RepassChange[] = targets.flatMap((sample) => {
    const after = repassed.get(sampleKey(sample))!
    const lowered = sample.retainedResult.findings.flatMap((finding, index) => {
      const rerated = after.retainedResult.findings[index]!
      return rerated.severity === finding.severity
        ? []
        : [{ title: finding.title, path: finding.path, startLine: finding.startLine, from: finding.severity, to: rerated.severity }]
    })
    return [{ caseId: sample.caseId, before: "BLOCK", after: after.conclusion === "failure" ? "BLOCK" : "PASS", lowered }]
  })
  const run = evalRunSchema.parse({
    ...sourceRun,
    samples,
    repassedFrom: {
      sourceArtifactHash: artifactHash(sourceBytes),
      repassedAt: options.repassedAt,
      prompt: severityRepassIdentifier(),
      mode: reviewMode,
      model: pinnedModel,
      account: options.account,
      attempted: targets.length,
      failed,
    },
  })
  return {
    run,
    attempted: targets.length,
    failed,
    changes,
    evidenceBoundaryViolations: [...repassed.values()].filter(
      (sample) => (sample.severityRepass?.evidenceBoundaryViolations.length ?? 0) > 0,
    ).length,
  }
}

async function repassSample(
  sample: Extract<EvalSample, { status: "completed" }>,
  evalCase: EvalCase,
  sourcePreparation: string,
  options: RepassOptions,
  runReview: RunRepassReview,
): Promise<Extract<EvalSample, { status: "completed" }>> {
  const job = evalJob(evalCase, sample.sample)
  const indices = blockingFindingIndices(sample.retainedResult, failOn)
  const prompt = `${buildSourceSetupPrompt(sourcePreparation)}\n\n${buildSeverityRepassPrompt(
    job,
    sample.retainedResult,
    indices,
    { failOn, preparedSource: true },
  )}`
  const target = {
    repository: evalCase.repositoryFullName,
    pullNumber: evalCase.pullNumber,
    baseSha: evalCase.baseSha,
    headSha: evalCase.headSha,
  }
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error("Severity re-pass timed out")),
    options.timeoutMs,
  )
  const common = { promptHash: hash(prompt), prompt }
  let repass: SeverityRepass
  try {
    const review = await runReview({
      prompt,
      title: `Severity check: ${reviewThreadTitle(job)}`,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
      ...(options.reviewerApiKey === undefined ? {} : { apiKey: options.reviewerApiKey }),
    })
    const evidence = {
      threadId: review.threadId,
      models: [...new Set([...review.models, ...modelsFromTrace(review.trace)])],
      durationMs: Date.now() - startedAt,
      retries: review.retries,
      trace: review.trace,
      evidenceBoundaryViolations: checkReviewTrace(review.trace, sourcePreparation, target, reviewMode, "plugin"),
    }
    if (review.status === "error") {
      repass = { ...common, ...evidence, status: "error", error: review.error }
    } else if (evidence.evidenceBoundaryViolations.length > 0) {
      // A rating built on evidence the rules forbid cannot remove a block.
      repass = {
        ...common,
        ...evidence,
        status: "error",
        error: `did not follow the review rules: ${evidence.evidenceBoundaryViolations.join("; ")}`,
      }
    } else {
      try {
        const ratings = parseSeverityRepassResult(review.rawResult, indices)
        repass = { ...common, ...evidence, status: "completed", rawResult: review.rawResult, ratings }
      } catch (error) {
        repass = {
          ...common,
          ...evidence,
          status: "error",
          error: `Severity re-pass returned an invalid result: ${errorMessage(error)}`,
        }
      }
    }
  } catch (error) {
    repass = {
      ...common,
      threadId: null,
      models: [],
      durationMs: Date.now() - startedAt,
      evidenceBoundaryViolations: [],
      status: "error",
      error: errorMessage(error),
    }
  } finally {
    clearTimeout(timeout)
  }

  // A failed re-pass keeps the review's own severities: it can only remove a
  // block, so an error must not let a pull request through.
  const retainedResult =
    repass.status === "completed" ? applySeverityRatings(sample.retainedResult, repass.ratings) : sample.retainedResult
  return {
    ...sample,
    retainedResult,
    conclusion: checkConclusion(retainedResult, failOn),
    severityRepass: repass,
  }
}

export function formatRepassSummary(result: RepassResult): string {
  const lines = [
    `Re-passed reviews: ${result.attempted} blocked of ${result.run.samples.length} saved`,
    `Re-pass failures (review severities kept): ${result.failed}`,
    `Re-pass evidence-boundary violations: ${result.evidenceBoundaryViolations}`,
    "Lowered findings: case | before -> after | finding (file:line) old -> new",
  ]
  const lowered = result.changes.filter((change) => change.lowered.length > 0)
  if (lowered.length === 0) lines.push("  none")
  for (const change of lowered) {
    for (const finding of change.lowered) {
      lines.push(
        `  ${change.caseId} | ${change.before} -> ${change.after} | ${finding.title} (${finding.path}:${finding.startLine}) ${finding.from} -> ${finding.to}`,
      )
    }
  }
  return lines.join("\n")
}

/** The review job a saved evaluation review used; the re-pass must see the same one. */
export function evalJob(evalCase: EvalCase, sample: number): ReviewJob {
  return {
    id: `eval-${evalCase.id}-${sample}`,
    sourceDeliveryId: `eval-${evalCase.id}-${sample}`,
    eventType: "eval.replay",
    installationId: "0",
    repositoryId: "0",
    repositoryFullName: evalCase.repositoryFullName,
    pullNumber: evalCase.pullNumber,
    baseSha: evalCase.baseSha,
    headSha: evalCase.headSha,
    ampProject: "no-project",
    pullRequestContext: evalCase.context,
    checkRunId: null,
    ampThreadId: null,
    status: "running",
    attempts: 1,
  }
}

function identifyingJob(): ReviewJob {
  return {
    id: "prompt-identifier",
    sourceDeliveryId: "prompt-identifier",
    eventType: "eval.prompt-identifier",
    installationId: "0",
    repositoryId: "0",
    repositoryFullName: "example/repository",
    pullNumber: 1,
    baseSha: "0".repeat(40),
    headSha: "1".repeat(40),
    ampProject: "no-project",
    pullRequestContext: null,
    checkRunId: null,
    ampThreadId: null,
    status: "running",
    attempts: 1,
  }
}

function sampleKey(sample: EvalSample): string {
  return `${sample.caseId}\0${sample.sample}`
}

async function mapConcurrent<Input>(
  inputs: Input[],
  concurrency: number,
  work: (input: Input) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= inputs.length) return
      await work(inputs[index]!)
    }
  })
  await Promise.all(workers)
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function artifactHash(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8_000)
}
