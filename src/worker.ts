import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { execute } from "@ampcode/sdk"
import type { Logger } from "pino"
import type { Config } from "./config.js"
import { Database } from "./database.js"
import { GitHubClient } from "./github.js"
import { buildReviewPrompt, parseReviewResult, reviewThreadTitle } from "./review.js"
import type { ReviewJob } from "./types.js"

const execFileAsync = promisify(execFile)

export class ReviewWorkers {
  private stopping = false
  private readonly active = new Set<AbortController>()
  private readonly loops: Promise<void>[] = []

  constructor(
    private readonly config: Config,
    private readonly database: Database,
    private readonly github: GitHubClient,
    private readonly logger: Logger,
  ) {}

  start(): void {
    for (let index = 0; index < this.config.workerConcurrency; index += 1) {
      this.loops.push(this.loop(index))
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    for (const controller of this.active) controller.abort(new Error("Service is shutting down"))
    await Promise.all(this.loops)
  }

  private async loop(index: number): Promise<void> {
    const log = this.logger.child({ worker: index })
    while (!this.stopping) {
      try {
        const job = await this.database.claim()
        if (!job) {
          await sleep(1_000)
          continue
        }
        if (this.stopping) {
          await this.database.requeue(job.id)
          break
        }
        await this.review(job, log)
      } catch (error) {
        log.error({ err: error }, "worker loop failed")
        await sleep(2_000)
      }
    }
  }

  private async review(initialJob: ReviewJob, logger: Logger): Promise<void> {
    let job = initialJob
    let checkRunId = job.checkRunId
    const controller = new AbortController()
    this.active.add(controller)
    const timeout = setTimeout(
      () => controller.abort(new Error("Review timed out")),
      this.config.reviewTimeoutMs,
    )
    const cancellationPoll = setInterval(() => {
      void this.database.status(job.id).then((status) => {
        if (status === "cancelled") controller.abort(new Error("Review superseded"))
      })
    }, 2_000)
    const log = logger.child({ jobId: job.id, repository: job.repositoryFullName, pr: job.pullNumber })

    try {
      if (!checkRunId) {
        checkRunId = await this.github.createCheck(job)
        await this.database.setCheckRun(job.id, checkRunId)
        job = { ...job, checkRunId }
      }
      await this.github.startCheck(job, checkRunId)

      if ((await this.github.currentHead(job)) !== job.headSha) {
        await this.github.cancelCheck(job, checkRunId, "A newer pull request revision is available.")
        await this.database.finish(job.id, "cancelled", "Pull request head changed")
        return
      }

      let finalText: string | undefined
      for await (const message of execute({
        prompt: buildReviewPrompt(job),
        signal: controller.signal,
        options: {
          executor: "orb",
          project: job.ampProject,
          mode: "medium",
          visibility: this.config.ampThreadVisibility,
          labels: ["reviewbot"],
          noArchiveAfterExecute: true,
        },
      })) {
        if (message.type === "system" && message.session_id !== job.ampThreadId) {
          job = { ...job, ampThreadId: message.session_id }
          await this.database.setThread(job.id, message.session_id)
          try {
            await this.github.linkCheck(job, checkRunId, message.session_id)
          } catch (error) {
            log.warn({ err: error, threadId: message.session_id }, "failed to link running check")
          }
          log.info({ threadId: message.session_id }, "Amp review started")
        }
        if (message.type === "result") {
          if (message.is_error) throw new Error(message.error)
          finalText = message.result
        }
      }

      if (!finalText) throw new Error("Amp returned no review result")
      if ((await this.database.status(job.id)) === "cancelled") throw new Error("Review superseded")
      if ((await this.github.currentHead(job)) !== job.headSha) {
        await this.github.cancelCheck(job, checkRunId, "A newer pull request revision is available.")
        await this.database.finish(job.id, "cancelled", "Pull request head changed")
        return
      }

      const result = parseReviewResult(finalText)
      const changedLines = await this.github.changedLines(job)
      await this.github.completeCheck(job, checkRunId, result, changedLines)
      await this.database.finish(job.id, "succeeded")
      log.info({ findings: result.findings.length }, "review completed")
    } catch (error) {
      const reason = errorMessage(error)
      const cancelled = (await this.database.status(job.id)) === "cancelled"
      log.error({ err: error, cancelled }, "review failed")

      if (this.stopping && !cancelled) {
        await this.database.requeue(job.id)
        return
      }

      if (checkRunId) {
        try {
          if (cancelled) {
            await this.github.cancelCheck(job, checkRunId, "This review was superseded by a newer revision.")
          } else {
            await this.github.failCheck(
              job,
              checkRunId,
              "Amp Review could not complete. Use GitHub's re-run control to try again.",
            )
          }
        } catch (checkError) {
          log.error({ err: checkError }, "failed to update check after review error")
        }
      }
      if (!cancelled) await this.database.finish(job.id, "failed", reason)
    } finally {
      if (job.ampThreadId) {
        try {
          await execFileAsync(
            resolve("node_modules", ".bin", "amp"),
            ["threads", "rename", job.ampThreadId, reviewThreadTitle(job)],
            { timeout: 30_000 },
          )
        } catch (error) {
          log.warn({ err: error, threadId: job.ampThreadId }, "failed to rename Amp review thread")
        }
      }
      clearTimeout(timeout)
      clearInterval(cancellationPoll)
      this.active.delete(controller)
    }
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8_000)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
