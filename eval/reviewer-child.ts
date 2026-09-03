import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { StreamMessage } from "@ampcode/sdk"
import pino from "pino"
import { z } from "zod"
import { reviewMode } from "../src/amp.js"
import { executeReviewWithRetries } from "../src/worker.js"
import { checkReviewTrace, modelsFromTrace } from "./evidence.js"

const execFileAsync = promisify(execFile)
const inputSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  sourceSetup: z
    .object({
      prompt: z.string().min(1),
      preparation: z.string().min(1),
      target: z.object({
        repository: z.string().min(1),
        pullNumber: z.number().int().positive(),
        baseSha: z.string().min(1),
        headSha: z.string().min(1),
      }),
    })
    .optional(),
})
const setupRetryPrompt =
  "Complete only the source setup requested in the first message, then end the turn. Do not begin the review."

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
  let threadId: string | null = null

  try {
    try {
      const runTurn = (prompt: string, continueThreadId?: string, retryPrompt?: string) =>
        executeReviewWithRetries({
          prompt,
          title: input.title,
          cwd: input.cwd,
          visibility: "private",
          signal: controller.signal,
          logger: pino({ level: "silent" }),
          onThread: async (id) => {
            threadId = id
          },
          beforeRetry: async () => {},
          onMessage: (message) => {
            trace.push(message)
          },
          ...(continueThreadId === undefined ? {} : { continueThreadId }),
          ...(retryPrompt === undefined ? {} : { retryPrompt }),
        })

      if (input.sourceSetup) {
        await runTurn(input.sourceSetup.prompt, undefined, setupRetryPrompt)
        const problems = checkReviewTrace(
          trace,
          input.sourceSetup.preparation,
          input.sourceSetup.target,
          reviewMode,
          true,
        )
        if (problems.length > 0) {
          throw new Error(`Source setup failed its checks: ${problems.join("; ")}`)
        }
        if (!threadId) throw new Error("Source setup did not create a review thread")
      }

      const rawResult = await runTurn(input.prompt, threadId ?? undefined)
      process.stdout.write(
        `${JSON.stringify({ status: "completed", rawResult, threadId, models: modelsFromTrace(trace), trace })}\n`,
      )
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ status: "error", error: errorMessage(error), threadId, models: modelsFromTrace(trace), trace })}\n`,
      )
    }
  } finally {
    clearTimeout(timeout)
    process.removeListener("SIGTERM", abort)
    process.removeListener("SIGINT", abort)
    if (threadId) await archiveThread(threadId)
  }
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
