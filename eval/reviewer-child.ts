import { execFile, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  AmpOptionsSchema,
  type ExecuteOptions,
  type ResolvedAmpOptions,
  type StreamMessage,
} from "@ampcode/sdk"
import pino from "pino"
import { z } from "zod"
import { reviewMode } from "../src/amp.js"
import { executeReviewWithRetries } from "../src/worker.js"
import { modelsFromTrace } from "./evidence.js"

const execFileAsync = promisify(execFile)
const inputSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive(),
})
const pluginReadyTimeoutSeconds = 30
const sdkVersion = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(resolve("node_modules", "@ampcode", "sdk", "package.json"), "utf8")))
  .version

async function main(): Promise<void> {
  const input = inputSchema.parse(JSON.parse(await readStdin()))
  const controller = new AbortController()
  const abort = () => controller.abort(new Error("Evaluation review was cancelled"))
  process.once("SIGTERM", abort)
  process.once("SIGINT", abort)
  const timeout = setTimeout(
    () => controller.abort(new Error("Evaluation review timed out")),
    input.timeoutMs,
  )
  const trace: StreamMessage[] = []
  const threadIds: string[] = []

  try {
    try {
      const rawResult = await executeReviewWithRetries({
        prompt: input.prompt,
        title: input.title,
        cwd: input.cwd,
        visibility: "private",
        signal: controller.signal,
        logger: pino({ level: "silent" }),
        onThread: async (id) => {
          // A restart in a fresh thread abandons the earlier thread; only the
          // thread that produced the result is evidence for the review.
          if (threadIds.length > 0) keepThreadTrace(trace, id)
          threadIds.push(id)
        },
        beforeRetry: async () => {},
        onMessage: (message) => {
          trace.push(message)
        },
        executeAmp: executeAmpWithPluginReady,
      })
      process.stdout.write(
        `${JSON.stringify({ status: "completed", rawResult, threadId: threadIds.at(-1) ?? null, models: modelsFromTrace(trace), trace })}\n`,
      )
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ status: "error", error: errorMessage(error), threadId: threadIds.at(-1) ?? null, models: modelsFromTrace(trace), trace })}\n`,
      )
    }
  } finally {
    clearTimeout(timeout)
    process.removeListener("SIGTERM", abort)
    process.removeListener("SIGINT", abort)
    for (const id of threadIds) await archiveThread(id)
  }
}

export function keepThreadTrace(trace: StreamMessage[], threadId: string): void {
  const kept = trace.filter(
    (message) => !("session_id" in message) || message.session_id === threadId,
  )
  trace.splice(0, trace.length, ...kept)
}

export async function* executeAmpWithPluginReady({
  prompt,
  options = {},
  signal,
}: ExecuteOptions): AsyncIterable<StreamMessage> {
  if (typeof prompt !== "string") throw new Error("Evaluation reviews require a text prompt")
  const resolved = AmpOptionsSchema.parse(options)
  if (resolved.executor !== "orb") throw new Error("Evaluation reviews require an orb")

  const child = spawn(resolve("node_modules", ".bin", "amp"), evaluationAmpArgs(resolved), {
    cwd: resolved.cwd ?? process.cwd(),
    env: { ...process.env, ...resolved.env, AMP_SDK_VERSION: sdkVersion },
    signal,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let childError: Error | undefined
  let stderr = ""
  child.once("error", (error) => {
    childError = error
  })
  child.stdin.once("error", () => {})
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 1_000_000) stderr += chunk.toString("utf8")
  })
  const closed = new Promise<{ code: number | null; processSignal: NodeJS.Signals | null }>(
    (resolveClose) => {
      child.once("close", (code, processSignal) => resolveClose({ code, processSignal }))
    },
  )

  child.stdin.end(`${prompt}\n`)
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try {
        yield JSON.parse(line) as StreamMessage
      } catch (error) {
        throw new Error(`Amp returned invalid stream JSON: ${line.slice(0, 500)}`, {
          cause: error,
        })
      }
    }
    const { code, processSignal } = await closed
    if (signal?.aborted) throw signal.reason
    if (childError) throw childError
    if (code === null) throw new Error(`Amp CLI was killed by ${processSignal ?? "an unknown signal"}`)
    if (code !== 0) {
      throw new Error(`Amp CLI exited with status ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)
    }
  } finally {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  }
}

export function evaluationAmpArgs(options: ResolvedAmpOptions): string[] {
  const args: string[] = []
  if (typeof options.continue === "string") {
    args.push("threads", "continue", options.continue)
  } else if (options.continue === true) {
    args.push("threads", "continue")
  }
  args.push(
    "--execute",
    "--stream-json",
    "--orb-execute",
    "--plugin-ready-timeout",
    String(pluginReadyTimeoutSeconds),
    "--mode",
    options.mode,
  )
  if (options.project) args.push("--project", options.project)
  if (options.noArchiveAfterExecute || options.archive === false) {
    args.push("--no-archive-after-execute")
  }
  if (options.visibility) {
    args.push("--visibility", options.visibility === "public" ? "unlisted" : options.visibility)
  }
  for (const label of options.labels ?? []) args.push("--label", label)
  if (options.title) args.push("--title", options.title)
  return args
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

async function archiveThread(threadId: string): Promise<void> {
  try {
    await execFileAsync(
      resolve("node_modules", ".bin", "amp"),
      ["threads", "archive", threadId],
      { timeout: 30_000 },
    )
  } catch {
    process.stderr.write("Warning: an evaluation review thread could not be archived.\n")
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8_000)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
