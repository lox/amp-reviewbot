import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
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

export type AccountSeparation = {
  separation: "verified-user-id"
  trustedIdHash: string
  reviewerIdHash: string
}

type SpawnReviewer = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: ["pipe", "pipe", "pipe"]
  },
) => ChildProcessWithoutNullStreams

export async function verifySeparateAmpAccounts(
  trustedApiKey: string,
  reviewerApiKey: string,
  fetchAmp: typeof fetch = fetch,
  ampUrl = process.env.AMP_URL ?? "https://ampcode.com",
): Promise<AccountSeparation> {
  const [trustedUserId, reviewerUserId] = await Promise.all([
    ampUserId(trustedApiKey, fetchAmp, ampUrl),
    ampUserId(reviewerApiKey, fetchAmp, ampUrl),
  ])
  if (trustedUserId === reviewerUserId) {
    throw new Error("The trusted and blind-review keys belong to the same Amp account")
  }
  return {
    separation: "verified-user-id",
    trustedIdHash: hashId(trustedUserId),
    reviewerIdHash: hashId(reviewerUserId),
  }
}

export async function runBlindReview(
  input: BlindReviewInput,
  spawnReviewer: SpawnReviewer = spawn,
): Promise<z.infer<typeof outputSchema>> {
  input.signal.throwIfAborted()
  const home = await mkdtemp(join(tmpdir(), "amp-reviewbot-reviewer-"))
  try {
    const { args, entry } = await childCommand()
    return await new Promise((resolveReview, rejectReview) => {
      const child = spawnReviewer(process.execPath, [...args, entry], {
        cwd: resolve("."),
        env: reviewerEnvironment(input.apiKey, home),
        stdio: ["pipe", "pipe", "pipe"],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let childError: Error | undefined
      let inputError: Error | undefined
      let forceKillTimer: NodeJS.Timeout | undefined
      const stopChild = () => {
        if (forceKillTimer) return
        child.kill("SIGTERM")
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
      }
      const abort = () => stopChild()
      input.signal.addEventListener("abort", abort, { once: true })
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.once("error", (error) => {
        childError = error
      })
      child.stdin.once("error", (error) => {
        inputError = new Error("Could not send review input to the blind reviewer", { cause: error })
        stopChild()
      })
      child.once("close", (code) => {
        cleanup()
        if (input.signal.aborted) {
          rejectReview(input.signal.reason)
          return
        }
        const errorMessage = Buffer.concat(stderr).toString("utf8").trim()
        if (childError) {
          rejectReview(childError)
          return
        }
        if (inputError) {
          rejectReview(errorMessage ? new Error(errorMessage, { cause: inputError }) : inputError)
          return
        }
        if (code !== 0) {
          rejectReview(new Error(errorMessage || `Blind reviewer exited with status ${code}`))
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

      function cleanup(): void {
        input.signal.removeEventListener("abort", abort)
        if (forceKillTimer) clearTimeout(forceKillTimer)
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

async function ampUserId(
  apiKey: string,
  fetchAmp: typeof fetch,
  ampUrl: string,
): Promise<string> {
  const response = await fetchAmp(new URL("/api/user-actor-credentials", ampUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`Could not verify Amp account identity (HTTP ${response.status})`)
  }
  const result: unknown = await response.json()
  return z.object({ userId: z.string().min(1) }).passthrough().parse(result).userId
}

function hashId(userId: string): string {
  return `sha256:${createHash("sha256").update(userId).digest("hex")}`
}
