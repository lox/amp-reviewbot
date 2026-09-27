import timers from "node:timers/promises"
import type { Logger } from "pino"
import type { Database } from "./database.js"

/** Logs updates, not counters. Consumers keep the latest snapshot per reviewId. */
export async function logReviewSummaries(
  database: Pick<Database, "recentReviewSummaries">,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  let previous = new Map<string, string>()
  while (!signal.aborted) {
    try {
      const current = new Map<string, string>()
      for (const summary of await database.recentReviewSummaries()) {
        const id = String(summary.reviewId)
        const serialized = JSON.stringify(summary)
        current.set(id, serialized)
        if (previous.get(id) !== serialized) {
          logger.info({ event: "review_summary", ...summary }, "review summary")
        }
      }
      previous = current
    } catch (error) {
      logger.warn({ err: error }, "could not collect review summaries")
    }
    try {
      await timers.setTimeout(60_000, undefined, { signal })
    } catch (error) {
      if (signal.aborted) return
      throw error
    }
  }
}
