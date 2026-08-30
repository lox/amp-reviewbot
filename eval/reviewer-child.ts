import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { StreamMessage } from "@ampcode/sdk"
import pino from "pino"
import { z } from "zod"
import { executeReviewWithRetries } from "../src/worker.js"

const execFileAsync = promisify(execFile)
const inputSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1),
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive(),
})

async function main(): Promise<void> {
  const input = inputSchema.parse(JSON.parse(await readStdin()))
  const controller = new AbortController()
  const abort = () => controller.abort(new Error("Blind review was cancelled"))
  process.once("SIGTERM", abort)
  process.once("SIGINT", abort)
  const timeout = setTimeout(
    () => controller.abort(new Error("Blind review timed out")),
    input.timeoutMs,
  )
  const models = new Set<string>()
  const trace: StreamMessage[] = []
  let threadId: string | null = null

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
          threadId = id
        },
        beforeRetry: async () => {},
        onMessage: (message) => {
          trace.push(message)
          if (message.type === "assistant" && typeof message.message.model === "string") {
            models.add(message.message.model)
          }
        },
      })
      process.stdout.write(
        `${JSON.stringify({ status: "completed", rawResult, threadId, models: [...models], trace })}\n`,
      )
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ status: "error", error: errorMessage(error), threadId, models: [...models], trace })}\n`,
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
    process.stderr.write("Warning: a blind review thread could not be archived.\n")
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
