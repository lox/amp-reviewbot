import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, open, readFile, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import pino from "pino"
import { z } from "zod"
import { buildReviewPrompt, finalizeReview, parseReviewResult, reviewThreadTitle } from "../src/review.js"
import type { ReviewJob } from "../src/types.js"
import { executeReviewWithRetries, reviewMode } from "../src/worker.js"
import { judgeFindings } from "./judge.js"
import {
  corpusContentHash,
  corpusSchema,
  evalRunSchema,
  type EvalCase,
  type EvalRun,
  type EvalSample,
} from "./schema.js"
import { formatReport } from "./report.js"
import { scoreRun, type EvalScore } from "./score.js"

const execFileAsync = promisify(execFile)
const logger = pino({ level: process.env.LOG_LEVEL ?? "silent" })
const failOn = "high" as const

type RunOptions = {
  corpusPath: string
  outputPath: string
  cacheDirectory: string
  samplesPerCase: number
  concurrency: number
  timeoutMs: number
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === "check" || command === "validate") {
    const corpusPath = requiredInput(process.argv.slice(3), "--corpus")
    const input: unknown = JSON.parse(await readFile(corpusPath, "utf8"))
    const corpus = corpusSchema.parse(input)
    const examples = new Set(corpus.cases.map((evalCase) => evalCase.seedId)).size
    console.log(
      `Example file looks good: ${corpus.cases.length} code versions across ${examples} ${examples === 1 ? "example" : "examples"}.`,
    )
    return
  }
  if (command === "run") {
    const options = runOptions(process.argv.slice(3))
    await mkdir(dirname(options.outputPath), { recursive: true })
    const output = await createRunArtifact(options.outputPath)
    let complete = false
    try {
      const { run, score } = await runEvaluation(options)
      await output.writeFile(`${JSON.stringify({ ...run, score }, null, 2)}\n`)
      complete = true
      console.log(`\n${formatReport(run, score)}`)
      console.log(`\nFull results: ${options.outputPath}`)
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
  const input: unknown = JSON.parse(await readFile(options.corpusPath, "utf8"))
  const corpus = corpusSchema.parse(input)
  const startedAt = new Date().toISOString()
  const reviewer = await reviewerProvenance()
  const tasks = corpus.cases.flatMap((evalCase) =>
    Array.from({ length: options.samplesPerCase }, (_, index) => ({
      evalCase,
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

  const samples = await mapConcurrent(tasks, options.concurrency, async ({ evalCase, sample }) => {
    const result = await runSample(evalCase, sample, options, reviewer.sdkVersion)
    finished += 1
    const outcome = result.status === "completed" ? "completed" : "did not complete"
    console.log(
      `[${finished}/${tasks.length}] Example ${exampleNumbers.get(evalCase.seedId)}, ${kindLabel(evalCase)}, run ${sample} of ${options.samplesPerCase}: ${outcome} (${formatDuration(result.durationMs)})`,
    )
    return result
  })

  const run = evalRunSchema.parse({
    schemaVersion: 1,
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

async function runSample(
  evalCase: EvalCase,
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
  const models = new Set<string>()
  let threadId: string | null = null
  const job = evalJob(evalCase, sample)
  const prompt = buildReviewPrompt(job)
  const promptHash = hash(prompt)

  try {
    const rawResult = await executeReviewWithRetries({
      prompt,
      title: reviewThreadTitle(job),
      project: job.ampProject,
      visibility: "private",
      signal: controller.signal,
      logger: logger.child({ caseId: evalCase.id, sample }),
      onThread: async (id) => {
        threadId = id
      },
      beforeRetry: async () => {},
      onMessage: (message) => {
        if (message.type === "assistant" && typeof message.message.model === "string") {
          models.add(message.message.model)
        }
      },
    })
    const parsedResult = parseReviewResult(rawResult)
    const finalized = finalizeReview(parsedResult, changedLineMap(evalCase), failOn)
    let judgement = null
    let judgementError: string | null = null

    if (evalCase.expected.issue) {
      try {
        if (finalized.result.findings.length > 0) {
          judgement = await judgeFindings(
            evalCase,
            finalized.result.findings,
            options.cacheDirectory,
            sdkVersion,
            controller.signal,
          )
        }
      } catch (error) {
        controller.signal.throwIfAborted()
        judgementError = errorMessage(error)
      }
    }

    return {
      caseId: evalCase.id,
      sample,
      expected: evalCase.expected,
      promptHash,
      threadId,
      models: [...models],
      durationMs: Date.now() - startedAt,
      status: "completed",
      rawResult,
      parsedResult,
      retainedResult: finalized.result,
      omitted: finalized.omitted,
      conclusion: finalized.conclusion,
      judgement,
      judgementError,
    }
  } catch (error) {
    return {
      caseId: evalCase.id,
      sample,
      expected: evalCase.expected,
      promptHash,
      threadId,
      models: [...models],
      durationMs: Date.now() - startedAt,
      status: "error",
      error: errorMessage(error),
    }
  } finally {
    clearTimeout(timeout)
    if (threadId) await archiveThread(threadId)
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
    ampProject: evalCase.ampProject,
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

async function reviewerProvenance(): Promise<EvalRun["reviewer"]> {
  const [{ stdout: gitCommit }, { stdout: status }, sdkPackage, reviewSource, workerSource, methodology] =
    await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"]),
      execFileAsync("git", ["status", "--porcelain"]),
      readFile(resolve("node_modules", "@ampcode", "sdk", "package.json"), "utf8"),
      readFile(resolve("src", "review.ts"), "utf8"),
      readFile(resolve("src", "worker.ts"), "utf8"),
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
    reviewSourceHash: hash(`${reviewSource}\n${workerSource}`),
    methodologyHash: hash(methodology),
  }
}

async function archiveThread(threadId: string): Promise<void> {
  try {
    await execFileAsync(
      resolve("node_modules", ".bin", "amp"),
      ["threads", "archive", threadId],
      { timeout: 30_000 },
    )
  } catch (error) {
    logger.warn({ err: error, threadId }, "failed to archive eval review thread")
    console.warn("Warning: an Amp review thread could not be archived.")
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
  const corpusPath = requiredInput(args, "--corpus")
  const samplesPerCase = positiveInteger(flag(args, "--samples") ?? "3", "--samples", 20)
  const concurrency = positiveInteger(flag(args, "--concurrency") ?? "2", "--concurrency", 10)
  const timeoutMinutes = positiveInteger(flag(args, "--timeout-minutes") ?? "30", "--timeout-minutes", 120)
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
  return {
    corpusPath,
    outputPath: flag(args, "--output") ?? resolve(".eval-runs", `${stamp}.json`),
    cacheDirectory: flag(args, "--cache") ?? resolve(".eval-cache", "judge"),
    samplesPerCase,
    concurrency,
    timeoutMs: timeoutMinutes * 60_000,
  }
}

function requiredInput(args: string[], oldFlag: string): string {
  const value = args[0] && !args[0].startsWith("--") ? args[0] : flag(args, oldFlag)
  if (!value) throw new Error("Missing input file")
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

function kindLabel(evalCase: EvalCase): string {
  if (evalCase.expected.kind === "control") return "clean change"
  return evalCase.expected.kind === "advisory" ? "smaller bug" : "serious bug"
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval -- check PATH
  npm run eval -- run PATH [--samples 3] [--concurrency 2] [--output PATH]
  npm run eval -- report PATH

Check an example file, run the reviews, or read a saved report. Full technical evidence stays in the saved run file.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
