import pino from "pino"
import { loadConfig } from "./config.js"
import { Database } from "./database.js"
import { GitHubClient } from "./github.js"
import { createMetricsServer } from "./metrics.js"
import { createHttpServer } from "./server.js"
import { ReviewWorkers } from "./worker.js"

const config = loadConfig()
const logger = pino({ level: config.logLevel })
const database = new Database(config)

await database.migrate()

const github = new GitHubClient(config)
const workers = new ReviewWorkers(config, database, github, logger)
const server = createHttpServer(config, database, logger)
const metricsServer = createMetricsServer(database, logger)

workers.start()
metricsServer.listen(9091, "0.0.0.0")
server.listen(config.port, "0.0.0.0", () => {
  logger.info({ port: config.port, workers: config.workerConcurrency }, "amp-reviewbot started")
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, "shutting down")
  await Promise.all([server, metricsServer].map((listener) => new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()))
  })))
  await workers.stop()
  await database.close()
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
