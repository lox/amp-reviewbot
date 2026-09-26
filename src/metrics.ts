import { createServer, type Server } from "node:http"
import type { Logger } from "pino"
import type { Database } from "./database.js"

// A separate listener keeps business metrics off the public webhook service.
export function createMetricsServer(database: Pick<Database, "metrics">, logger: Logger): Server {
  return createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/metrics") {
      response.writeHead(404).end()
      return
    }
    try {
      const metrics = await database.metrics()
      const body = Object.entries(metrics).map(([name, value]) => {
        const metric = `reviewbot_${name}`
        // Empty latency populations are unknown, not zero-second reviews.
        return `# TYPE ${metric} gauge\n${metric} ${value ?? "NaN"}\n`
      }).join("")
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
      response.end(body)
    } catch (error) {
      logger.error({ err: error }, "metrics collection failed")
      response.writeHead(503).end("metrics collection failed\n")
    }
  })
}
