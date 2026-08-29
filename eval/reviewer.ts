import { spawn } from "node:child_process"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const outputSchema = z.object({
  rawResult: z.string(),
  threadId: z.string().nullable(),
  models: z.array(z.string()),
})

export type BlindReviewInput = {
  prompt: string
  title: string
  project: string
  timeoutMs: number
  apiKey: string
  signal: AbortSignal
}

export async function runBlindReview(input: BlindReviewInput): Promise<z.infer<typeof outputSchema>> {
  input.signal.throwIfAborted()
  const home = await mkdtemp(join(tmpdir(), "amp-reviewbot-reviewer-"))
  try {
    const { args, entry } = await childCommand()
    return await new Promise((resolveReview, rejectReview) => {
      const child = spawn(process.execPath, [...args, entry], {
        cwd: resolve("."),
        env: reviewerEnvironment(input.apiKey, home),
        stdio: ["pipe", "pipe", "pipe"],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const abort = () => child.kill("SIGTERM")
      input.signal.addEventListener("abort", abort, { once: true })
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.on("error", finishReject)
      child.on("close", (code) => {
        cleanup()
        if (input.signal.aborted) {
          rejectReview(input.signal.reason)
          return
        }
        const error = Buffer.concat(stderr).toString("utf8").trim()
        if (code !== 0) {
          rejectReview(new Error(error || `Blind reviewer exited with status ${code}`))
          return
        }
        try {
          resolveReview(outputSchema.parse(JSON.parse(Buffer.concat(stdout).toString("utf8"))))
        } catch (parseError) {
          rejectReview(new Error("Blind reviewer returned an invalid result", { cause: parseError }))
        }
      })
      child.stdin.end(
        JSON.stringify({
          prompt: input.prompt,
          title: input.title,
          project: input.project,
          timeoutMs: input.timeoutMs,
        }),
      )

      function finishReject(error: Error): void {
        cleanup()
        rejectReview(error)
      }

      function cleanup(): void {
        input.signal.removeEventListener("abort", abort)
      }
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

export function reviewerEnvironment(apiKey: string, home: string): NodeJS.ProcessEnv {
  const inherited = [
    "PATH",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "AMP_URL",
  ]
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    AMP_API_KEY: apiKey,
  }
  for (const name of inherited) {
    if (process.env[name]) environment[name] = process.env[name]
  }
  return environment
}

async function childCommand(): Promise<{ args: string[]; entry: string }> {
  const directory = dirname(fileURLToPath(import.meta.url))
  const source = join(directory, "reviewer-child.ts")
  if ((await stat(source).catch(() => null))?.isFile()) {
    return { args: ["--import", "tsx"], entry: source }
  }
  return { args: [], entry: join(directory, "reviewer-child.js") }
}
