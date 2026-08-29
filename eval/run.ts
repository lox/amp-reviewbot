import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, open, readFile, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { z } from "zod"
import { buildReviewPrompt, finalizeReview, parseReviewResult, reviewThreadTitle } from "../src/review.js"
import type { ReviewFinding, ReviewJob } from "../src/types.js"
import { reviewMode } from "../src/worker.js"
import { judgeIssue } from "./judge.js"
import { checkPack, describePack, loadPack } from "./pack.js"
import { formatReport } from "./report.js"
import {
  reviewAuthentication,
  runBlindReview,
  type ReviewAuthentication,
} from "./reviewer.js"
import {
  corpusContentHash,
  evalRunSchema,
  expectedKind,
  type EvalCase,
  type EvalRun,
  type EvalSample,
} from "./schema.js"
import { scoreRun, type EvalScore } from "./score.js"

const execFileAsync = promisify(execFile)
const failOn = "high" as const

type RunOptions = {
  packPath: string
  project: string
  reviewerApiKey?: string
  outputPath: string
  judgeCache: string
  sourceCache: string
  samplesPerCase: number
  concurrency: number
  timeoutMs: number
}

type FinishOptions = {
  runPath: string
  outputPath: string
  judgeCache: string
  concurrency: number
  timeoutMs: number
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
    try {
      const { run, score } = await runEvaluation(options)
      await output.writeFile(`${JSON.stringify(run, null, 2)}\n`)
      complete = true
      console.log(`\n${formatReport(run, score)}`)
      console.log(`\nFull results: ${options.outputPath}`)
    } finally {
      await output.close()
      if (!complete) await unlink(options.outputPath).catch(() => {})
    }
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
        await installedSdkVersion(),
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
      console.log(`\n${formatReport(finishedRun, scoreRun(finishedRun))}`)
      console.log(`\nFinished results: ${options.outputPath}`)
    } finally {
      await output.close()
      if (!complete) await unlink(options.outputPath).catch(() => {})
    }
    return
  }
  if (command === "report" || command === "score") {
    const runPath = requiredInput(process.argv.slice(3), "--run")
    const input: unknown = JSON.parse(await readFile(runPath, "utf8"))
    const run = evalRunSchema.parse(input)
    console.log(formatReport(run, scoreRun(run)))
    return
  }
  printHelp()
  if (command && command !== "help" && command !== "--help") process.exitCode = 1
}

async function runEvaluation(options: RunOptions): Promise<{ run: EvalRun; score: EvalScore }> {
  console.log(
    options.reviewerApiKey
      ? "Checking the review account key..."
      : "Using the authenticated local Amp CLI for reviews and matching...",
  )
  const account = await reviewAuthentication(options.reviewerApiKey)
  console.log("Checking source commits and changed lines...")
  const { corpus, sourcePreparation } = await loadPack(options.packPath, options.sourceCache)
  const startedAt = new Date().toISOString()
  const reviewer = await reviewerProvenance(options.project, account)
  const tasks = corpus.cases.flatMap((evalCase) =>
    Array.from({ length: options.samplesPerCase }, (_, index) => ({
      evalCase,
      sourcePreparation: sourcePreparation.get(evalCase.id),
      sample: index + 1,
    })),
  )
  const exampleNumbers = new Map<string, number>()
  for (const evalCase of corpus.cases) {
    if (!exampleNumbers.has(evalCase.seedId)) {
      exampleNumbers.set(evalCase.seedId, exampleNumbers.size + 1)
    }
  }
  let finished = 0
  console.log(`Running ${tasks.length} reviews, up to ${options.concurrency} at a time...`)

  const samples = await mapConcurrent(
    tasks,
    options.concurrency,
    async ({ evalCase, sourcePreparation: preparation, sample }) => {
      const result = await runSample(evalCase, preparation, sample, options, reviewer.sdkVersion)
      finished += 1
      const outcome = result.status === "completed" ? "completed" : "did not complete"
      console.log(
        `[${finished}/${tasks.length}] Example ${exampleNumbers.get(evalCase.seedId)}, ${kindLabel(evalCase)}, run ${sample} of ${options.samplesPerCase}: ${outcome} (${formatDuration(result.durationMs)})`,
      )
      return result
    },
  )

  const run = evalRunSchema.parse({
    schemaVersion: 2,
    corpusVersion: corpus.version,
    corpusHash: corpusContentHash(corpus),
    startedAt,
    completedAt: new Date().toISOString(),
    requestedSamplesPerCase: options.samplesPerCase,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    reviewer,
    cases: corpus.cases,
    samples,
  })
  return { run, score: scoreRun(run) }
}

export async function finishJudgements(
  sourceRun: EvalRun,
  options: Pick<FinishOptions, "judgeCache" | "concurrency" | "timeoutMs">,
  sdkVersion: string,
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
        sdkVersion,
        AbortSignal.timeout(options.timeoutMs),
      )
      finished += 1
      onProgress?.(finished, tasks.length, true)
      return { ...task, judgement }
    } catch (error) {
      finished += 1
      onProgress?.(finished, tasks.length, false)
      return { ...task, error: errorMessage(error) }
    }
  })

  for (const result of results) {
    const sample = samples[result.sampleIndex]!
    if (sample.status !== "completed") throw new Error("Expected a completed review sample")
    sample.judgementErrors = sample.judgementErrors.filter(
      (error) => error.issueId !== result.issue.id,
    )
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

async function runSample(
  evalCase: EvalCase,
  sourcePreparation: string | undefined,
  sample: number,
  options: RunOptions,
  sdkVersion: string,
): Promise<EvalSample> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error("Eval review timed out")),
    options.timeoutMs,
  )
  let threadId: string | null = null
  let models: string[] = []
  const job = evalJob(evalCase, sample, options.project)
  const prompt = buildReviewPrompt(job, sourcePreparation)
  const promptHash = hash(prompt)

  try {
    const review = await runBlindReview({
      prompt,
      title: reviewThreadTitle(job),
      project: options.project,
      timeoutMs: options.timeoutMs,
      signal: controller.signal,
      ...(options.reviewerApiKey ? { apiKey: options.reviewerApiKey } : {}),
    })
    threadId = review.threadId
    models = review.models
    const parsedResult = parseReviewResult(review.rawResult)
    const finalized = finalizeReview(parsedResult, changedLineMap(evalCase), failOn)
    const judgements = []
    const judgementErrors = []

    if (finalized.result.findings.length > 0) {
      for (const issue of evalCase.expected.issues) {
        try {
          judgements.push(
            await judgeIssue(
              evalCase.id,
              issue,
              finalized.result.findings,
              options.judgeCache,
              sdkVersion,
              controller.signal,
            ),
          )
        } catch (error) {
          controller.signal.throwIfAborted()
          judgementErrors.push({ issueId: issue.id, error: errorMessage(error) })
        }
      }
    }

    return {
      caseId: evalCase.id,
      sample,
      expected: evalCase.expected,
      promptHash,
      threadId,
      models,
      durationMs: Date.now() - startedAt,
      status: "completed",
      rawResult: review.rawResult,
      parsedResult,
      retainedResult: finalized.result,
      omitted: finalized.omitted,
      conclusion: finalized.conclusion,
      judgements,
      judgementErrors,
    }
  } catch (error) {
    return {
      caseId: evalCase.id,
      sample,
      expected: evalCase.expected,
      promptHash,
      threadId,
      models,
      durationMs: Date.now() - startedAt,
      status: "error",
      error: errorMessage(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function evalJob(evalCase: EvalCase, sample: number, project: string): ReviewJob {
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
    ampProject: project,
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
  project: string,
  account: ReviewAuthentication,
): Promise<EvalRun["reviewer"]> {
  const [
    { stdout: gitCommit },
    { stdout: status },
    sdkPackage,
    reviewSource,
    workerSource,
    reviewerSource,
    reviewerChildSource,
    methodology,
  ] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"]),
    execFileAsync("git", ["status", "--porcelain"]),
    readFile(resolve("node_modules", "@ampcode", "sdk", "package.json"), "utf8"),
    readFile(resolve("src", "review.ts"), "utf8"),
    readFile(resolve("src", "worker.ts"), "utf8"),
    readFile(resolve("eval", "reviewer.ts"), "utf8"),
    readFile(resolve("eval", "reviewer-child.ts"), "utf8"),
    readFile(resolve(".agents", "skills", "general-code-reviewing", "SKILL.md"), "utf8"),
  ])
  const sdk: unknown = JSON.parse(sdkPackage)
  const sdkVersion = z.object({ version: z.string() }).parse(sdk).version
  return {
    gitCommit: gitCommit.trim(),
    dirty: status.trim().length > 0,
    sdkVersion,
    mode: reviewMode,
    failOn,
    reviewSourceHash: hash(
      `${reviewSource}\n${workerSource}\n${reviewerSource}\n${reviewerChildSource}`,
    ),
    methodologyHash: hash(methodology),
    project,
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
  const project = flag(args, "--project")
  if (!project) throw new Error("Missing --project")
  if (process.env.AMP_API_KEY) {
    throw new Error(
      "Unset AMP_API_KEY; evaluation uses the authenticated local Amp CLI. Set AMP_EVAL_REVIEWER_API_KEY only to override review-orb authentication.",
    )
  }
  const reviewerApiKey = process.env.AMP_EVAL_REVIEWER_API_KEY
  delete process.env.AMP_EVAL_REVIEWER_API_KEY

  const samplesPerCase = positiveInteger(flag(args, "--samples") ?? "3", "--samples", 20)
  const concurrency = positiveInteger(flag(args, "--concurrency") ?? "2", "--concurrency", 10)
  const timeoutMinutes = positiveInteger(
    flag(args, "--timeout-minutes") ?? "30",
    "--timeout-minutes",
    120,
  )
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
  const cacheRoot = flag(args, "--cache") ?? resolve(".eval-cache")
  return {
    packPath,
    project,
    ...(reviewerApiKey ? { reviewerApiKey } : {}),
    outputPath: flag(args, "--output") ?? resolve(".eval-runs", `${stamp}.json`),
    judgeCache: resolve(cacheRoot, "judge"),
    sourceCache: resolve(cacheRoot, "source"),
    samplesPerCase,
    concurrency,
    timeoutMs: timeoutMinutes * 60_000,
  }
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

async function installedSdkVersion(): Promise<string> {
  const packageJson: unknown = JSON.parse(
    await readFile(resolve("node_modules", "@ampcode", "sdk", "package.json"), "utf8"),
  )
  return z.object({ version: z.string() }).parse(packageJson).version
}

function kindLabel(evalCase: EvalCase): string {
  const kind = expectedKind(evalCase.expected)
  if (kind === "control") return "clean change"
  return kind === "advisory" ? "smaller bug" : "serious bug"
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval -- check PACK
  npm run eval -- run PACK --project PROJECT [--samples 3] [--concurrency 2]
  npm run eval -- finish RUN.json [--concurrency 2]
  npm run eval -- report RUN.json

Check an example pack, run reviews, finish interrupted finding comparisons, or read a saved report. Reviews and matching use the authenticated local Amp CLI. Set AMP_EVAL_REVIEWER_API_KEY only when review orbs should use another account.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
