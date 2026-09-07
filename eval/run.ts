import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { z } from "zod"
import {
  buildReviewPrompt,
  buildSourceSetupPrompt,
  finalizeReview,
  parseReviewResult,
  reviewThreadTitle,
  severityGuide,
} from "../src/review.js"
import type { ReviewFinding, ReviewJob } from "../src/types.js"
import { pinnedModel, reviewMode } from "../src/amp.js"
import { checkReviewTrace, modelsFromTrace } from "./evidence.js"
import { formatAbDecision, interleavedAbTasks, loadFrozenSet, type AbVariant } from "./ab.js"
import { judgeIssue, type AmpVersions } from "./judge.js"
import { checkPack, describePack, loadPack } from "./pack.js"
import { formatReport } from "./report.js"
import { formatComparison } from "./compare.js"
import {
  readThreadUsage,
  reviewAuthentication,
  runEvaluationReview,
  type ReviewAuthentication,
} from "./reviewer.js"
import {
  corpusContentHash,
  evalRunSchema,
  expectedKind,
  type EvalCase,
  type EvalCorpus,
  type EvalRun,
  type EvalSample,
  type ThreadUsage,
} from "./schema.js"
import { scoreRun, type EvalScore } from "./score.js"

const execFileAsync = promisify(execFile)
const failOn = "high" as const

type RunOptions = {
  packPath: string
  reviewerApiKey: string
  outputPath: string
  judgeCache: string
  sourceCache: string
  samplesPerCase: number
  concurrency: number
  timeoutMs: number
  judgeTimeoutMs: number
  orderSeed: string
  split: NonNullable<EvalCase["split"]>
  versions: VersionKind[]
}

type FinishOptions = {
  runPath: string
  outputPath: string
  judgeCache: string
  concurrency: number
  timeoutMs: number
}

type AbOptions = {
  packPath: string
  setName: string
  promptVariantA: string
  promptVariantB: string
  reviewerApiKey: string
  concurrency: number
  timeoutMs: number
  orderSeed: string
  sourceCache: string
  outputA: string
  outputB: string
}

type FinishProgress = (finished: number, total: number, succeeded: boolean) => void

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === "check" || command === "validate") {
    const packPath = requiredInput(process.argv.slice(3), "--corpus")
    const { summary } = await checkPack(packPath)
    console.log(`Example pack format looks good: ${describePack(summary)}.`)
    return
  }
  if (command === "run") {
    const options = runOptions(process.argv.slice(3))
    await mkdir(dirname(options.outputPath), { recursive: true })
    const output = await createRunArtifact(options.outputPath)
    let complete = false
    let checkpointed = false
    try {
      const { run } = await runEvaluation(options, async (reviewedRun) => {
        await writeRunArtifact(output, reviewedRun)
        checkpointed = true
        console.log(`Review checkpoint: ${options.outputPath}`)
      })
      await replaceRunArtifact(options.outputPath, run)
      complete = true
      console.log(`\n${formatReport(run)}`)
      console.log(`\nFull results: ${options.outputPath}`)
    } finally {
      await output.close()
      if (!complete && !checkpointed) await unlink(options.outputPath).catch(() => {})
    }
    return
  }
  if (command === "ab") {
    const options = abOptions(process.argv.slice(3))
    const result = await runAb(options)
    console.log(`\n${result.decision}`)
    console.log(`\nA results: ${options.outputA}\nB results: ${options.outputB}`)
    return
  }
  if (command === "finish") {
    const options = finishOptions(process.argv.slice(3))
    const sourceBytes = await readFile(options.runPath)
    const sourceRun = evalRunSchema.parse(JSON.parse(sourceBytes.toString("utf8")))
    await mkdir(dirname(options.outputPath), { recursive: true })
    const output = await createRunArtifact(options.outputPath)
    let complete = false
    try {
      console.log("Finishing saved finding comparisons...")
      const { run, attempted } = await finishJudgements(
        sourceRun,
        options,
        await installedAmpVersions(),
        judgeIssue,
        (finished, total, succeeded) => {
          console.log(
            `[${finished}/${total}] Finding comparison ${succeeded ? "completed" : "did not complete"}`,
          )
        },
      )
      if (attempted === 0) throw new Error("This saved result has no unfinished comparisons")
      const finishedRun = recordFinishedRun(run, sourceBytes, new Date().toISOString())
      await output.writeFile(`${JSON.stringify(finishedRun, null, 2)}\n`)
      complete = true
      console.log(`\n${formatReport(finishedRun)}`)
      console.log(`\nFinished results: ${options.outputPath}`)
    } finally {
      await output.close()
      if (!complete) await unlink(options.outputPath).catch(() => {})
    }
    return
  }
  if (command === "report" || command === "score") {
    const runPath = requiredInput(process.argv.slice(3), "--run")
    console.log(formatReport(await readRun(runPath)))
    return
  }
  if (command === "compare") {
    const [pathA, pathB] = process.argv.slice(3, 5)
    if (!pathA || !pathB) throw new Error("compare needs two saved result files: compare A.json B.json")
    console.log(
      formatComparison(
        { name: pathA, run: await readRun(pathA) },
        { name: pathB, run: await readRun(pathB) },
      ),
    )
    return
  }
  printHelp()
  if (command && command !== "help" && command !== "--help") process.exitCode = 1
}

async function readRun(path: string): Promise<EvalRun> {
  return evalRunSchema.parse(JSON.parse(await readFile(path, "utf8")))
}

async function runEvaluation(
  options: RunOptions,
  onReviewsCompleted: (run: EvalRun) => Promise<void>,
): Promise<{ run: EvalRun; score: EvalScore }> {
  console.log("Checking the separate review account key...")
  const account = await reviewAuthentication(options.reviewerApiKey)
  console.log("Checking source commits and changed lines...")
  const loaded = await loadPack(options.packPath, options.sourceCache)
  const cases = selectCases(loaded.corpus.cases, options.split, options.versions)
  if (cases.length === 0) throw new Error(`The example pack has no matching ${options.split} cases`)
  // The full pack was validated on load; a filtered subset may hold only one
  // half of a synthetic pair, so it is not re-checked as a pack.
  const corpus: EvalCorpus = {
    version: `${loaded.corpus.version}-${options.split}${options.versions.length === allVersionKinds.length ? "" : `-${options.versions.join("+")}`}`,
    cases,
  }
  const sourcePreparation = loaded.sourcePreparation
  const startedAt = new Date().toISOString()
  const reviewer = await reviewerProvenance(account, [options.outputPath])
  const tasks = orderedReviewTasks(corpus.cases, options.samplesPerCase, options.orderSeed).map(
    ({ evalCase, sample }) => ({
      evalCase,
      sourcePreparation: sourcePreparation.get(evalCase.id),
      sample,
    }),
  )
  const exampleNumbers = new Map<string, number>()
  for (const evalCase of corpus.cases) {
    if (!exampleNumbers.has(evalCase.seedId)) {
      exampleNumbers.set(evalCase.seedId, exampleNumbers.size + 1)
    }
  }
  let finished = 0
  console.log(`Running ${tasks.length} reviews, up to ${options.concurrency} at a time...`)

  const samples: EvalSample[] = []
  for (let sampleNumber = 1; sampleNumber <= options.samplesPerCase; sampleNumber += 1) {
    const block = tasks.filter((task) => task.sample === sampleNumber)
    samples.push(
      ...(await mapConcurrent(
        block,
        options.concurrency,
        async ({ evalCase, sourcePreparation: preparation, sample }) => {
          const result = await runReviewSample(evalCase, preparation, sample, options)
          finished += 1
          const outcome = result.status === "completed" ? "completed" : "did not complete"
          console.log(
            `[${finished}/${tasks.length}] Example ${exampleNumbers.get(evalCase.seedId)}, ${kindLabel(evalCase)}, run ${sample} of ${options.samplesPerCase}: ${outcome} (${formatDuration(result.durationMs)})`,
          )
          return result
        },
      )),
    )
  }

  const reviewsCompletedAt = new Date().toISOString()
  const reviewedRun = evalRunSchema.parse({
    schemaVersion: 3,
    corpusVersion: corpus.version,
    corpusHash: corpusContentHash(corpus),
    startedAt,
    reviewsCompletedAt,
    completedAt: reviewsCompletedAt,
    requestedSamplesPerCase: options.samplesPerCase,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    judgeTimeoutMs: options.judgeTimeoutMs,
    orderSeed: options.orderSeed,
    executionOrder: tasks.map(({ evalCase, sample }) => ({ caseId: evalCase.id, sample })),
    reviewer,
    cases: corpus.cases,
    samples,
  })
  await onReviewsCompleted(reviewedRun)
  console.log("Checking review findings against the recorded issues...")
  const { run: judgedRun } = await finishJudgements(
    reviewedRun,
    {
      judgeCache: options.judgeCache,
      concurrency: options.concurrency,
      timeoutMs: options.judgeTimeoutMs,
    },
    { sdkVersion: reviewer.sdkVersion, cliVersion: reviewer.cliVersion },
    judgeIssue,
    (matched, total, succeeded) => {
      console.log(
        `[${matched}/${total}] Finding comparison ${succeeded ? "completed" : "did not complete"}`,
      )
    },
  )
  const run = evalRunSchema.parse({ ...judgedRun, completedAt: new Date().toISOString() })
  return { run, score: scoreRun(run) }
}

async function runAb(options: AbOptions): Promise<{ runA: EvalRun; runB: EvalRun; decision: string }> {
  const wallStarted = Date.now()
  console.log("Checking the separate review account key...")
  const account = await reviewAuthentication(options.reviewerApiKey)
  console.log("Checking source commits, changed lines, and the frozen set...")
  const loaded = await loadPack(options.packPath, options.sourceCache)
  const frozen = await loadFrozenSet(options.packPath, options.setName, loaded.corpus.cases)
  const [variantA, variantB] = await Promise.all([
    loadPromptVariant(options.promptVariantA),
    loadPromptVariant(options.promptVariantB),
  ])
  const promptA = new Map(frozen.cases.map((evalCase) => [evalCase.id, variantA.build(evalJob(evalCase, 1))]))
  const promptB = new Map(frozen.cases.map((evalCase) => [evalCase.id, variantB.build(evalJob(evalCase, 1))]))
  const reviewer = await reviewerProvenance(account, [options.outputA, options.outputB])
  const startedAt = new Date().toISOString()
  const tasks = interleavedAbTasks(frozen.cases, options.orderSeed)
  let finished = 0
  console.log(`Running ${tasks.length} interleaved reviews, up to ${options.concurrency} at a time...`)
  const results = await mapConcurrent(tasks, options.concurrency, async ({ evalCase, variant }) => {
    const reviewPrompt = (variant === "A" ? promptA : promptB).get(evalCase.id)
    if (!reviewPrompt) throw new Error(`Prompt ${variant} was not built for ${evalCase.id}`)
    const sample = await runReviewSample(
      evalCase,
      loaded.sourcePreparation.get(evalCase.id),
      1,
      options,
      { reviewPrompt, collectUsage: false },
    )
    finished += 1
    console.log(
      `[${finished}/${tasks.length}] ${evalCase.id}, prompt ${variant}: ${sample.status === "completed" ? "completed" : "did not complete"} (${formatDuration(sample.durationMs)})`,
    )
    return { variant, sample }
  })
  const completedAt = new Date().toISOString()
  const makeRun = (variant: AbVariant): EvalRun => {
    const samples = results.filter((result) => result.variant === variant).map((result) => result.sample)
    const cases = frozen.cases
    return evalRunSchema.parse({
      schemaVersion: 3,
      corpusVersion: `${loaded.corpus.version}-${frozen.identifier}`,
      corpusHash: corpusContentHash({ version: `${loaded.corpus.version}-${frozen.identifier}`, cases }),
      startedAt,
      reviewsCompletedAt: completedAt,
      completedAt,
      requestedSamplesPerCase: 1,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      judgeTimeoutMs: options.timeoutMs,
      orderSeed: options.orderSeed,
      executionOrder: samples.map((sample) => ({ caseId: sample.caseId, sample: sample.sample })),
      reviewer,
      cases,
      samples,
    })
  }
  const runA = makeRun("A")
  const runB = makeRun("B")
  await Promise.all([
    writeNewRun(options.outputA, runA),
    writeNewRun(options.outputB, runB),
  ])
  return {
    runA,
    runB,
    decision: formatAbDecision({
      setIdentifier: frozen.identifier,
      promptA: variantA.identifier,
      promptB: variantB.identifier,
      runA,
      runB,
      wallTimeMs: Date.now() - wallStarted,
    }),
  }
}

export function orderedReviewTasks(
  cases: EvalCase[],
  samplesPerCase: number,
  orderSeed: string,
): Array<{ evalCase: EvalCase; sample: number }> {
  return Array.from({ length: samplesPerCase }, (_, index) => index + 1).flatMap((sample) =>
    [...cases]
      .sort((left, right) => {
        const leftKey = hash(`${orderSeed}\0${sample}\0${left.id}`)
        const rightKey = hash(`${orderSeed}\0${sample}\0${right.id}`)
        return leftKey.localeCompare(rightKey)
      })
      .map((evalCase) => ({ evalCase, sample })),
  )
}

export type VersionKind = ReturnType<typeof expectedKind>
export const allVersionKinds: VersionKind[] = ["blocking", "advisory", "control"]

export function selectCases(
  cases: EvalCase[],
  split: NonNullable<EvalCase["split"]>,
  versions: VersionKind[] = allVersionKinds,
): EvalCase[] {
  return cases.filter(
    (evalCase) =>
      (split === "development" ? evalCase.split !== "holdout" : evalCase.split === "holdout") &&
      versions.includes(expectedKind(evalCase.expected)),
  )
}

export async function finishJudgements(
  sourceRun: EvalRun,
  options: Pick<FinishOptions, "judgeCache" | "concurrency" | "timeoutMs">,
  versions: AmpVersions,
  judge: typeof judgeIssue = judgeIssue,
  onProgress?: FinishProgress,
): Promise<{ run: EvalRun; attempted: number }> {
  const samples = structuredClone(sourceRun.samples)
  const tasks = samples.flatMap((sample, sampleIndex) => {
    if (sample.status !== "completed" || sample.retainedResult.findings.length === 0) return []
    const checkedIssues = new Set(sample.judgements.map((judgement) => judgement.issueId))
    return sample.expected.issues
      .filter((issue) => !checkedIssues.has(issue.id))
      .map((issue) => ({ sampleIndex, caseId: sample.caseId, issue }))
  })
  let finished = 0
  const results = await mapConcurrent(tasks, options.concurrency, async (task) => {
    const startedAt = Date.now()
    const sample = samples[task.sampleIndex]!
    if (sample.status !== "completed") throw new Error("Expected a completed review sample")
    const findings: ReviewFinding[] = sample.retainedResult.findings.map(
      ({ endLine, ...finding }) => ({
        ...finding,
        ...(endLine === undefined ? {} : { endLine }),
      }),
    )
    try {
      const judgement = await judge(
        task.caseId,
        task.issue,
        findings,
        options.judgeCache,
        versions,
        AbortSignal.timeout(options.timeoutMs),
      )
      finished += 1
      onProgress?.(finished, tasks.length, true)
      return { ...task, judgement, durationMs: Date.now() - startedAt }
    } catch (error) {
      finished += 1
      onProgress?.(finished, tasks.length, false)
      return { ...task, error: errorMessage(error), durationMs: Date.now() - startedAt }
    }
  })

  for (const result of results) {
    const sample = samples[result.sampleIndex]!
    if (sample.status !== "completed") throw new Error("Expected a completed review sample")
    sample.judgementErrors = sample.judgementErrors.filter(
      (error) => error.issueId !== result.issue.id,
    )
    if (sourceRun.schemaVersion === 3) {
      sample.matchingDurationMs = (sample.matchingDurationMs ?? 0) + result.durationMs
      sample.durationMs += result.durationMs
    }
    if ("judgement" in result) sample.judgements.push(result.judgement)
    else sample.judgementErrors.push({ issueId: result.issue.id, error: result.error })
  }

  return {
    run: evalRunSchema.parse({ ...sourceRun, samples }),
    attempted: tasks.length,
  }
}

export function recordFinishedRun(
  run: EvalRun,
  sourceBytes: Buffer,
  finishedAt: string,
): EvalRun {
  return evalRunSchema.parse({
    ...run,
    finishedFrom: {
      sourceArtifactHash: artifactHash(sourceBytes),
      finishedAt,
    },
  })
}

async function runReviewSample(
  evalCase: EvalCase,
  sourcePreparation: string | undefined,
  sample: number,
  options: Pick<RunOptions, "reviewerApiKey" | "timeoutMs">,
  fast: { reviewPrompt?: string; collectUsage?: boolean } = {},
): Promise<EvalSample> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error("Eval review timed out")),
    options.timeoutMs,
  )
  let threadId: string | null = null
  let models: string[] = []
  let trace: unknown[] = []
  let usage: ThreadUsage | undefined
  let usageUnavailable: string | undefined
  let reviewDurationMs: number | undefined
  const job = evalJob(evalCase, sample)
  const target = {
    repository: evalCase.repositoryFullName,
    pullNumber: evalCase.pullNumber,
    baseSha: evalCase.baseSha,
    headSha: evalCase.headSha,
  }
  const reviewPrompt =
    fast.reviewPrompt ??
    buildReviewPrompt(job, { failOn, preparedSource: sourcePreparation !== undefined })
  const sourceSetupPrompt =
    sourcePreparation === undefined ? undefined : buildSourceSetupPrompt(sourcePreparation)
  const prompt =
    sourceSetupPrompt === undefined ? reviewPrompt : `${sourceSetupPrompt}\n\n${reviewPrompt}`
  const promptHash = hash(prompt)

  try {
    const review = await runEvaluationReview({
      prompt,
      title: reviewThreadTitle(job),
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
      apiKey: options.reviewerApiKey,
    })
    threadId = review.threadId
    trace = review.trace
    models = [...new Set([...review.models, ...modelsFromTrace(trace)])]
    reviewDurationMs = Date.now() - startedAt
    // The review is over and its deadline no longer applies; the usage lookup
    // is bookkeeping that must not change the review's status or duration.
    clearTimeout(timeout)
    if (threadId !== null && fast.collectUsage !== false) {
      const lookup = await readThreadUsage(threadId, options.reviewerApiKey)
      if ("usage" in lookup) usage = lookup.usage
      else usageUnavailable = lookup.unavailable
    }
    const evidenceBoundaryViolations = checkReviewTrace(
      trace,
      sourcePreparation,
      target,
      reviewMode,
      "plugin",
    )
    if (review.status === "error") {
      return {
        caseId: evalCase.id,
        sample,
        expected: evalCase.expected,
        promptHash,
        prompt,
        threadId,
        models,
        durationMs: reviewDurationMs,
        reviewDurationMs,
        matchingDurationMs: 0,
        trace,
        retries: review.retries,
        evidenceBoundaryViolations,
        usage,
        usageUnavailable,
        status: "error",
        error: review.error,
      }
    }
    const parsedResult = parseReviewResult(review.rawResult)
    const finalized = finalizeReview(parsedResult, changedLineMap(evalCase), failOn)

    return {
      caseId: evalCase.id,
      sample,
      expected: evalCase.expected,
      promptHash,
      prompt,
      threadId,
      models,
      durationMs: reviewDurationMs,
      reviewDurationMs,
      matchingDurationMs: 0,
      trace,
      retries: review.retries,
      evidenceBoundaryViolations,
      usage,
      usageUnavailable,
      status: "completed",
      rawResult: review.rawResult,
      parsedResult,
      retainedResult: finalized.result,
      omitted: finalized.omitted,
      conclusion: finalized.conclusion,
      judgements: [],
      judgementErrors: [],
    }
  } catch (error) {
    reviewDurationMs ??= Date.now() - startedAt
    return {
      caseId: evalCase.id,
      sample,
      expected: evalCase.expected,
      promptHash,
      prompt,
      threadId,
      models,
      durationMs: reviewDurationMs,
      reviewDurationMs,
      matchingDurationMs: 0,
      trace,
      evidenceBoundaryViolations: checkReviewTrace(
        trace,
        sourcePreparation,
        target,
        reviewMode,
        "plugin",
      ),
      usage,
      usageUnavailable,
      status: "error",
      error: errorMessage(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function evalJob(evalCase: EvalCase, sample: number): ReviewJob {
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

function changedLineMap(evalCase: EvalCase): Map<string, Set<number>> {
  return new Map(
    Object.entries(evalCase.changedLines).map(([path, lines]) => [path, new Set(lines)]),
  )
}

async function reviewerProvenance(
  account: ReviewAuthentication,
  ignoredPaths: string[] = [],
): Promise<Omit<EvalRun["reviewer"], "cliVersion"> & { cliVersion: string }> {
  const statusArgs = ["status", "--porcelain", "--untracked-files=all", "--", "."]
  for (const path of ignoredPaths) {
    const local = relative(resolve("."), resolve(path))
    if (local !== "" && local !== ".." && !local.startsWith(`..${sep}`)) {
      statusArgs.push(`:(exclude)${local}`)
    }
  }
  const [
    { stdout: gitCommit },
    { stdout: status },
    sdkPackage,
    cliPackage,
    reviewSource,
    workerSource,
    ampSource,
    reviewerSource,
    reviewerChildSource,
    pinnedModelPlugin,
    methodology,
  ] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"]),
    execFileAsync("git", statusArgs),
    readFile(resolve("node_modules", "@ampcode", "sdk", "package.json"), "utf8"),
    readFile(resolve("node_modules", "@ampcode", "cli", "package.json"), "utf8"),
    readFile(resolve("src", "review.ts"), "utf8"),
    readFile(resolve("src", "worker.ts"), "utf8"),
    readFile(resolve("src", "amp.ts"), "utf8"),
    readFile(resolve("eval", "reviewer.ts"), "utf8"),
    readFile(resolve("eval", "reviewer-child.ts"), "utf8"),
    readFile(resolve("plugins", "pinned-models.js"), "utf8"),
    readFile(resolve(".agents", "skills", "general-code-reviewing", "SKILL.md"), "utf8"),
  ])
  const sdk: unknown = JSON.parse(sdkPackage)
  const cli: unknown = JSON.parse(cliPackage)
  const sdkVersion = z.object({ version: z.string() }).parse(sdk).version
  const cliVersion = z.object({ version: z.string() }).parse(cli).version
  return {
    gitCommit: gitCommit.trim(),
    dirty: status.trim().length > 0,
    sdkVersion,
    cliVersion,
    mode: reviewMode,
    model: pinnedModel,
    failOn,
    reviewSourceHash: hash(
      `${reviewSource}\n${workerSource}\n${ampSource}\n${reviewerSource}\n${reviewerChildSource}\n${pinnedModelPlugin}`,
    ),
    methodologyHash: hash(methodology),
    project: null,
    protocol: "research-enabled-target-frozen-v5",
    account,
  }
}

async function mapConcurrent<Input, Output>(
  inputs: Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(inputs.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (next < inputs.length) {
        const index = next
        next += 1
        output[index] = await operation(inputs[index]!)
      }
    }),
  )
  return output
}

function runOptions(args: string[]): RunOptions {
  const packPath = requiredInput(args, "--corpus")
  if (flag(args, "--project")) {
    throw new Error("Remove --project; evaluation reviews now run without an Amp project")
  }
  if (process.env.AMP_API_KEY) {
    throw new Error(
      "Unset AMP_API_KEY; the evaluation uses the authenticated local Amp CLI to compare findings. Set AMP_EVAL_REVIEWER_API_KEY for the separate reviewer account.",
    )
  }
  const reviewerApiKey = process.env.AMP_EVAL_REVIEWER_API_KEY
  delete process.env.AMP_EVAL_REVIEWER_API_KEY
  if (!reviewerApiKey) {
    throw new Error(
      "Set AMP_EVAL_REVIEWER_API_KEY to a separate account that cannot access the example pack",
    )
  }

  const samplesPerCase = positiveInteger(flag(args, "--samples") ?? "3", "--samples", 20)
  const concurrency = positiveInteger(flag(args, "--concurrency") ?? "2", "--concurrency", 10)
  const timeoutMinutes = positiveInteger(
    flag(args, "--timeout-minutes") ?? "30",
    "--timeout-minutes",
    120,
  )
  const judgeTimeoutMinutes = positiveInteger(
    flag(args, "--judge-timeout-minutes") ?? "30",
    "--judge-timeout-minutes",
    120,
  )
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
  const cacheRoot = flag(args, "--cache") ?? resolve(".eval-cache")
  const split = flag(args, "--split") ?? "development"
  if (split !== "development" && split !== "holdout") {
    throw new Error("--split must be development or holdout")
  }
  const versions = [...new Set((flag(args, "--versions") ?? allVersionKinds.join(",")).split(","))]
  if (!versions.every((kind): kind is VersionKind => (allVersionKinds as string[]).includes(kind))) {
    throw new Error("--versions must list some of blocking, advisory, control (comma-separated)")
  }
  return {
    packPath,
    reviewerApiKey,
    outputPath: flag(args, "--output") ?? resolve(".eval-runs", `${stamp}.json`),
    judgeCache: resolve(cacheRoot, "judge"),
    sourceCache: resolve(cacheRoot, "source"),
    samplesPerCase,
    concurrency,
    timeoutMs: timeoutMinutes * 60_000,
    judgeTimeoutMs: judgeTimeoutMinutes * 60_000,
    orderSeed: flag(args, "--order-seed") ?? randomBytes(16).toString("hex"),
    split,
    versions,
  }
}

function abOptions(args: string[]): AbOptions {
  const [packPath, setName, promptVariantA, promptVariantB] = positionalArgs(args)
  if (!packPath || !setName || !promptVariantA || !promptVariantB) {
    throw new Error("ab needs PACK, SET, A_VARIANT, and B_VARIANT: ab PACK SET A_VARIANT B_VARIANT")
  }
  if (process.env.AMP_API_KEY) {
    throw new Error("Unset AMP_API_KEY; A/B reviews require the separate reviewer account")
  }
  const reviewerApiKey = process.env.AMP_EVAL_REVIEWER_API_KEY
  delete process.env.AMP_EVAL_REVIEWER_API_KEY
  if (!reviewerApiKey) {
    throw new Error("Set AMP_EVAL_REVIEWER_API_KEY to a separate account that cannot access the example pack")
  }
  const concurrency = positiveInteger(flag(args, "--concurrency") ?? "3", "--concurrency", 10)
  const timeoutMinutes = positiveInteger(flag(args, "--timeout-minutes") ?? "30", "--timeout-minutes", 120)
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
  const outputDirectory = resolve(packPath, ".eval-runs")
  const cacheRoot = flag(args, "--cache") ?? resolve(packPath, ".eval-cache")
  return {
    packPath,
    setName,
    promptVariantA,
    promptVariantB,
    reviewerApiKey,
    concurrency,
    timeoutMs: timeoutMinutes * 60_000,
    orderSeed: flag(args, "--order-seed") ?? randomBytes(16).toString("hex"),
    sourceCache: resolve(cacheRoot, "source"),
    outputA: resolve(outputDirectory, `${stamp}-${setName}-A.json`),
    outputB: resolve(outputDirectory, `${stamp}-${setName}-B.json`),
  }
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]!.startsWith("--")) index += 1
    else values.push(args[index]!)
  }
  return values
}

function finishOptions(args: string[]): FinishOptions {
  const runPath = requiredInput(args, "--run")
  if (process.env.AMP_API_KEY) {
    throw new Error("Unset AMP_API_KEY; finishing uses the authenticated local Amp CLI")
  }
  delete process.env.AMP_EVAL_REVIEWER_API_KEY
  const concurrency = positiveInteger(flag(args, "--concurrency") ?? "2", "--concurrency", 10)
  const timeoutMinutes = positiveInteger(
    flag(args, "--timeout-minutes") ?? "30",
    "--timeout-minutes",
    120,
  )
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
  const cacheRoot = flag(args, "--cache") ?? resolve(".eval-cache")
  return {
    runPath,
    outputPath: flag(args, "--output") ?? resolve(".eval-runs", `${stamp}-finished.json`),
    judgeCache: resolve(cacheRoot, "judge"),
    concurrency,
    timeoutMs: timeoutMinutes * 60_000,
  }
}

function requiredInput(args: string[], oldFlag: string): string {
  const value = args[0] && !args[0].startsWith("--") ? args[0] : flag(args, oldFlag)
  if (!value) throw new Error("Missing example pack path")
  return value
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

function positiveInteger(value: string, name: string, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`)
  }
  return parsed
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

async function createRunArtifact(path: string) {
  try {
    return await open(path, "wx", 0o600)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Run artifact already exists: ${path}`)
    }
    throw error
  }
}

async function writeRunArtifact(
  output: Awaited<ReturnType<typeof open>>,
  run: EvalRun,
): Promise<void> {
  const contents = Buffer.from(`${JSON.stringify(run, null, 2)}\n`)
  await output.truncate(0)
  let offset = 0
  while (offset < contents.length) {
    const { bytesWritten } = await output.write(
      contents,
      offset,
      contents.length - offset,
      offset,
    )
    if (bytesWritten === 0) throw new Error("Could not write the run artifact")
    offset += bytesWritten
  }
  await output.truncate(contents.length)
  await output.sync()
}

async function replaceRunArtifact(path: string, run: EvalRun): Promise<void> {
  const temporaryPath = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`
  const temporary = await open(temporaryPath, "wx", 0o600)
  try {
    await writeRunArtifact(temporary, run)
    await temporary.close()
    await rename(temporaryPath, path)
  } catch (error) {
    await temporary.close().catch(() => {})
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

async function writeNewRun(path: string, run: EvalRun): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const output = await createRunArtifact(path)
  try {
    await writeRunArtifact(output, run)
  } finally {
    await output.close()
  }
}

export async function loadPromptVariant(input: string): Promise<{
  identifier: string
  build: (job: ReviewJob) => string
}> {
  if (input === "current") {
    return promptVariant("current", (job) =>
      buildReviewPrompt(job, { failOn, preparedSource: true }),
    )
  }
  if (input === "pre-severity-guide") {
    const guide = `\n${severityGuide(failOn)}\n`
    return promptVariant("pre-severity-guide", (job) =>
      buildReviewPrompt(job, { failOn, preparedSource: true }).replace(guide, "\n"),
    )
  }
  const instructions = (await readFile(resolve(input), "utf8")).trim()
  if (!instructions) throw new Error(`Prompt variant file is empty: ${input}`)
  return promptVariant(input, (job) =>
    buildReviewPrompt(job, { failOn, preparedSource: true, additionalInstructions: instructions }),
  )
}

function promptVariant(name: string, build: (job: ReviewJob) => string) {
  const identifyingJob: ReviewJob = {
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
  return {
    identifier: `${name}@${hash(build(identifyingJob)).slice(0, 12)}`,
    build,
  }
}

async function installedAmpVersions(): Promise<AmpVersions> {
  const [sdkPackage, cliPackage] = await Promise.all([
    readFile(resolve("node_modules", "@ampcode", "sdk", "package.json"), "utf8"),
    readFile(resolve("node_modules", "@ampcode", "cli", "package.json"), "utf8"),
  ])
  return {
    sdkVersion: z.object({ version: z.string() }).parse(JSON.parse(sdkPackage)).version,
    cliVersion: z.object({ version: z.string() }).parse(JSON.parse(cliPackage)).version,
  }
}

function kindLabel(evalCase: EvalCase): string {
  const kind = expectedKind(evalCase.expected)
  if (kind === "control") return "no recorded issues"
  return kind === "advisory" ? "recorded non-blocking issues" : "recorded blocking issues"
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval -- check PACK
  npm run eval -- run PACK [--samples 3] [--concurrency 2] [--split development|holdout] [--versions blocking,control]
  npm run eval -- ab PACK SET A_VARIANT B_VARIANT [--concurrency 3]
  npm run eval -- finish RUN.json [--concurrency 2]
  npm run eval -- report RUN.json
  npm run eval -- compare A.json B.json

Run reviews with public research against a fixed copy of the target repository, compare two prompt versions on a frozen set, validate an example pack, finish interrupted comparisons, read a saved report, or compare two saved results version by version. Running reviews requires AMP_EVAL_REVIEWER_API_KEY for a separate account that cannot access the example pack.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
