import { createHmac, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Logger } from "pino"
import { z } from "zod"
import type { Config } from "./config.js"
import { resolveAmpProject } from "./config.js"
import { Database } from "./database.js"

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({
    id: z.number().int().positive(),
    full_name: z.string().regex(/^[^/]+\/[^/]+$/),
  }),
  pull_request: z.object({
    draft: z.boolean().optional().default(false),
    base: z.object({ sha: z.string().min(7) }),
    head: z.object({ sha: z.string().min(7) }),
  }),
})

const checkRunPayloadSchema = z.object({
  action: z.string(),
  check_run: z.object({
    id: z.number().int().positive(),
    external_id: z.string().nullable(),
    app: z.object({ id: z.number().int().positive() }),
  }),
})

const pullRequestActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"])

export function createHttpServer(config: Config, database: Database, logger: Logger): Server {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        await database.healthcheck()
        json(response, 200, { ok: true })
        return
      }

      if (request.method !== "POST" || request.url !== "/webhooks/github") {
        json(response, 404, { error: "not found" })
        return
      }

      const body = await readBody(request)
      const signature = header(request, "x-hub-signature-256")
      if (!signature || !verifySignature(body, signature, config.githubWebhookSecret)) {
        json(response, 401, { error: "invalid signature" })
        return
      }

      const deliveryId = header(request, "x-github-delivery")
      const event = header(request, "x-github-event")
      if (!deliveryId || !event) {
        json(response, 400, { error: "missing GitHub webhook headers" })
        return
      }

      const payload: unknown = JSON.parse(body.toString("utf8"))
      if (event === "pull_request") {
        await handlePullRequest(config, database, deliveryId, payload, logger)
      } else if (event === "check_run") {
        await handleCheckRun(config, database, deliveryId, payload, logger)
      }
      json(response, 202, { accepted: true })
    } catch (error) {
      logger.error({ err: error }, "webhook request failed")
      json(response, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500, {
        error: "request failed",
      })
    }
  })
}

async function handlePullRequest(
  config: Config,
  database: Database,
  deliveryId: string,
  input: unknown,
  logger: Logger,
): Promise<void> {
  const payload = pullRequestPayloadSchema.parse(input)
  if (payload.action === "closed" || payload.action === "converted_to_draft") {
    const cancelled = await database.cancelPull(
      String(payload.repository.id),
      payload.number,
      `Pull request was ${payload.action.replaceAll("_", " ")}`,
    )
    if (cancelled > 0) {
      logger.info({ repository: payload.repository.full_name, pr: payload.number, jobs: cancelled }, "reviews cancelled")
    }
    return
  }
  if (!pullRequestActions.has(payload.action)) return
  if (payload.pull_request.draft && payload.action !== "ready_for_review") return

  const job = await database.enqueue({
    sourceDeliveryId: deliveryId,
    eventType: `pull_request.${payload.action}`,
    installationId: String(payload.installation.id),
    repositoryId: String(payload.repository.id),
    repositoryFullName: payload.repository.full_name,
    pullNumber: payload.number,
    baseSha: payload.pull_request.base.sha,
    headSha: payload.pull_request.head.sha,
    ampProject: resolveAmpProject(config, payload.repository.full_name),
  })
  if (job) logger.info({ jobId: job.id, repository: job.repositoryFullName, pr: job.pullNumber }, "review queued")
}

async function handleCheckRun(
  config: Config,
  database: Database,
  deliveryId: string,
  input: unknown,
  logger: Logger,
): Promise<void> {
  const payload = checkRunPayloadSchema.parse(input)
  if (payload.action !== "rerequested" || payload.check_run.app.id !== config.githubAppId) return
  if (!payload.check_run.external_id || !/^\d+$/.test(payload.check_run.external_id)) return

  const job = await database.enqueueRerun(
    payload.check_run.external_id,
    deliveryId,
    String(payload.check_run.id),
  )
  if (job) logger.info({ jobId: job.id, sourceJobId: payload.check_run.external_id }, "review re-run queued")
}

function verifySignature(body: Buffer, supplied: string, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  const expectedBuffer = Buffer.from(expected)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 2 * 1024 * 1024) throw new Error("Webhook body is too large")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}
