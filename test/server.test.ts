import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { once } from "node:events"
import { afterEach, describe, it } from "node:test"
import pino from "pino"
import type { Config } from "../src/config.js"
import type { Database, NewReviewJob } from "../src/database.js"
import { createHttpServer } from "../src/server.js"
import type { ReviewJob } from "../src/types.js"

const servers: ReturnType<typeof createHttpServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe("GitHub webhook endpoint", () => {
  it("rejects an invalid signature", async () => {
    const { url } = await startServer(new FakeDatabase())
    const response = await fetch(`${url}/webhooks/github`, {
      method: "POST",
      headers: githubHeaders("bad-signature"),
      body: "{}",
    })
    assert.equal(response.status, 401)
  })

  it("queues a signed pull request event", async () => {
    const database = new FakeDatabase()
    const { url, config } = await startServer(database)
    const body = JSON.stringify({
      action: "opened",
      number: 42,
      installation: { id: 100 },
      repository: { id: 200, full_name: "lox/example" },
      pull_request: {
        draft: false,
        base: { sha: "aaaaaaaa" },
        head: { sha: "bbbbbbbb" },
      },
    })
    const signature = `sha256=${createHmac("sha256", config.githubWebhookSecret).update(body).digest("hex")}`
    const response = await fetch(`${url}/webhooks/github`, {
      method: "POST",
      headers: githubHeaders(signature),
      body,
    })

    assert.equal(response.status, 202)
    assert.equal(database.enqueued[0]?.repositoryFullName, "lox/example")
    assert.equal(database.enqueued[0]?.ampProject, "lox/example")
  })
})

class FakeDatabase {
  readonly enqueued: NewReviewJob[] = []

  async healthcheck(): Promise<void> {}

  async enqueue(input: NewReviewJob): Promise<ReviewJob | null> {
    this.enqueued.push(input)
    return {
      ...input,
      id: "1",
      checkRunId: null,
      ampThreadId: null,
      status: "queued",
      attempts: 0,
    }
  }

  async enqueueRerun(): Promise<null> {
    return null
  }
}

async function startServer(database: FakeDatabase): Promise<{ url: string; config: Config }> {
  const config = testConfig()
  const server = createHttpServer(config, database as unknown as Database, pino({ level: "silent" }))
  servers.push(server)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port")
  return { url: `http://127.0.0.1:${address.port}`, config }
}

function githubHeaders(signature: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": "delivery-1",
    "x-github-event": "pull_request",
    "x-hub-signature-256": signature,
  }
}

function testConfig(): Config {
  return {
    port: 0,
    databaseUrl: "postgres://localhost/reviewbot",
    databaseSsl: false,
    githubAppId: 123,
    githubPrivateKey: "test-key",
    githubWebhookSecret: "a-long-test-secret",
    ampProjects: {},
    ampThreadVisibility: "workspace",
    workerConcurrency: 1,
    reviewTimeoutMs: 300_000,
    failOn: "high",
    logLevel: "silent",
  }
}
