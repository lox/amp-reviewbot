import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { execute } from "@ampcode/sdk"
import type { StreamMessage } from "@ampcode/sdk"
import type { Logger } from "pino"
import { agentModeFromMessage, reviewMode } from "./amp.js"
import type { Config } from "./config.js"
import { Database } from "./database.js"
import { GitHubClient } from "./github.js"
import { buildReviewPrompt, parseReviewResult, reviewThreadTitle } from "./review.js"
import type { ReviewJob } from "./types.js"

const execFileAsync = promisify(execFile)
const ampRetryDelaysMs = [5_000, 20_000]
const staleRecoveryIntervalMs = 60_000
const maxJobAttempts = 3
const continuationPrompt =
  "Complete the review if necessary, then return only the final review JSON in the required schema."

type ExecuteAmp = typeof execute

type ExecuteReviewOptions = {
  prompt: string
  title: string
  visibility: Config["ampThreadVisibility"]
  signal: AbortSignal
  logger: Logger
  onThread: (threadId: string) => Promise<void>
  beforeRetry: () => Promise<void>
  onMessage?: (message: StreamMessage) => void
  executeAmp?: ExecuteAmp
  retryDelaysMs?: number[]
} & ({ project: string; cwd?: never } | { cwd: string; project?: never })

export async function executeReviewWithRetries({
  prompt,
  title,
  project,
  cwd,
  visibility,
  signal,
  logger,
  onThread,
  beforeRetry,
  onMessage,
  executeAmp = execute,
  retryDelaysMs = ampRetryDelaysMs,
}: ExecuteReviewOptions): Promise<string> {
  let threadId: string | undefined

  for (let attempt = 0; ; attempt += 1) {
    let assistantFallback: string | undefined
    try {
      const continuing = threadId !== undefined
      for await (const message of executeAmp({
        prompt: continuing ? continuationPrompt : prompt,
        signal,
        options: {
          executor: "orb",
          ...(cwd === undefined ? {} : { cwd }),
          ...(continuing
            ? { continue: threadId }
            : {
                ...(project === undefined ? {} : { project }),
                title,
                visibility,
                labels: ["reviewbot"],
              }),
          mode: reviewMode,
          noArchiveAfterExecute: true,
        },
      })) {
        onMessage?.(message)
        if (message.type === "system") {
          if (agentModeFromMessage(message) !== reviewMode) {
            throw new Error(`Amp started in an unexpected mode; expected ${reviewMode}`)
          }
          if (threadId && message.session_id !== threadId) {
            throw new Error(`Amp continued as unexpected thread ${message.session_id}`)
          }
          if (!threadId) {
            threadId = message.session_id
            try {
              await onThread(threadId)
            } catch (error) {
              throw new ReviewCallbackError("Failed to persist Amp thread", { cause: error })
            }
          }
        }
        if (isFinalAssistantMessage(message, threadId)) {
          assistantFallback = message.message.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("")
        }
        if (message.type === "result") {
          if (message.is_error) throw new Error(message.error)
          signal.throwIfAborted()
          return message.result
        }
      }
      throw new TransientAmpError("Amp stream ended without a result")
    } catch (error) {
      signal.throwIfAborted()
      if (isAmpCancellationError(error)) {
        throw new AmpReviewCancelledError(errorMessage(error))
      }
      if (!isTransientAmpError(error)) throw error

      if (assistantFallback && isValidReviewResult(assistantFallback)) {
        logger.warn({ err: error, attempt: attempt + 1 }, "using final assistant response after Amp stream failure")
        return assistantFallback
      }

      const delayMs = retryDelaysMs[attempt]
      if (delayMs === undefined) throw error
      await beforeRetry()
      logger.warn({ err: error, attempt: attempt + 1, delayMs }, "retrying Amp review")
      await sleep(delayMs, signal)
    }
  }
}

function isFinalAssistantMessage(
  message: StreamMessage,
  threadId: string | undefined,
): message is Extract<StreamMessage, { type: "assistant" }> {
  return (
    message.type === "assistant" &&
    message.parent_tool_use_id === null &&
    message.message.stop_reason === "end_turn" &&
    threadId !== undefined &&
    message.session_id === threadId
  )
}

function isValidReviewResult(text: string): boolean {
  try {
    parseReviewResult(text)
    return true
  } catch {
    return false
  }
}

class TransientAmpError extends Error {}
class ReviewCallbackError extends Error {}
class AmpReviewCancelledError extends Error {}

export function isAmpCancellationError(error: unknown): boolean {
  return /\buser cancel(?:l)?ed\b|\bcancel(?:l)?ed by (?:the )?user\b/i.test(errorMessage(error))
}

export function isTransientAmpError(error: unknown): boolean {
  if (error instanceof TransientAmpError) return true
  const message = errorMessage(error)
  return [
    /websocket.*\b(?:1006|1011|1012|1013)\b/i,
    /\b(?:ECONNRESET|EPIPE|ETIMEDOUT|EAI_AGAIN)\b/i,
    /socket hang up|premature|truncated stream/i,
    /\bHTTP\s+(?:408|429|5\d\d)\b/i,
    /overload|temporar(?:y|ily) unavailable/i,
    /thread.*\b(?:active|busy|running)\b|\b(?:active|busy|running)\b.*thread/i,
  ].some((pattern) => pattern.test(message))
}

export class ReviewWorkers {
  private stopping = false
  private readonly active = new Set<AbortController>()
  private readonly loops: Promise<void>[] = []
  private readonly recoveryController = new AbortController()

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
    this.loops.push(this.recoveryLoop())
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.recoveryController.abort(new Error("Service is shutting down"))
    for (const controller of this.active) controller.abort(new Error("Service is shutting down"))
    await Promise.all(this.loops)
  }

  private async recoveryLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const recovery = await this.database.recoverStaleJobs(
          this.config.reviewTimeoutMs,
          maxJobAttempts,
        )
        if (recovery.requeued > 0) {
          this.logger.warn({ jobs: recovery.requeued }, "recovered stale review jobs")
        }
        for (const job of recovery.exhausted) {
          try {
            if (job.checkRunId) {
              await this.github.failCheck(
                job,
                job.checkRunId,
                "Review stopped after repeated worker interruptions. Use GitHub's re-run control to try again.",
              )
            }
            await this.database.finish(job.id, "failed", "Worker recovery attempts exhausted")
            this.logger.error({ jobId: job.id, attempts: job.attempts }, "stale review recovery exhausted")
          } catch (error) {
            this.logger.error({ err: error, jobId: job.id }, "failed to finalize stale review")
          }
        }
      } catch (error) {
        this.logger.error({ err: error }, "stale review recovery failed")
      }

      try {
        await sleep(staleRecoveryIntervalMs, this.recoveryController.signal)
      } catch {
        if (this.stopping) return
        throw new Error("Stale review recovery interrupted")
      }
    }
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
    const log = logger.child({ jobId: job.id, repository: job.repositoryFullName, pr: job.pullNumber })
    this.active.add(controller)
    const timeout = setTimeout(
      () => controller.abort(new Error("Review timed out")),
      this.config.reviewTimeoutMs,
    )
    const cancellationPoll = setInterval(() => {
      void this.database
        .status(job.id)
        .then((status) => {
          if (status === "cancelled") controller.abort(new Error("Review superseded"))
        })
        .catch((error: unknown) => {
          log.warn({ err: error }, "failed to poll review cancellation")
        })
    }, 2_000)

    try {
      if (!checkRunId) {
        checkRunId = await this.github.createCheck(job)
        await this.database.setCheckRun(job.id, checkRunId)
        job = { ...job, checkRunId }
      }
      const activeCheckRunId = checkRunId
      await this.github.startCheck(job, activeCheckRunId)

      if ((await this.github.currentHead(job)) !== job.headSha) {
        await this.github.cancelCheck(job, activeCheckRunId, "A newer pull request revision is available.")
        await this.database.finish(job.id, "cancelled", "Pull request head changed")
        return
      }

      const finalText = await executeReviewWithRetries({
        prompt: buildReviewPrompt(job),
        title: reviewThreadTitle(job),
        signal: controller.signal,
        project: job.ampProject,
        visibility: this.config.ampThreadVisibility,
        logger: log,
        onThread: async (threadId) => {
          job = { ...job, ampThreadId: threadId }
          await this.database.setThread(job.id, threadId)
          try {
            await this.github.linkCheck(job, activeCheckRunId, threadId)
          } catch (error) {
            log.warn({ err: error, threadId }, "failed to link running check")
          }
          log.info({ threadId }, "Amp review started")
        },
        beforeRetry: async () => {
          if ((await this.database.status(job.id)) === "cancelled") {
            throw new Error("Review superseded")
          }
          if ((await this.github.currentHead(job)) !== job.headSha) {
            throw new PullRequestHeadChangedError()
          }
        },
      })

      if ((await this.database.status(job.id)) === "cancelled") throw new Error("Review superseded")
      if ((await this.github.currentHead(job)) !== job.headSha) {
        await this.github.cancelCheck(job, activeCheckRunId, "A newer pull request revision is available.")
        await this.database.finish(job.id, "cancelled", "Pull request head changed")
        return
      }

      const result = parseReviewResult(finalText)
      const changedLines = await this.github.changedLines(job)
      controller.signal.throwIfAborted()
      await this.github.completeCheck(job, activeCheckRunId, result, changedLines)
      await this.database.finish(job.id, "succeeded")
      log.info({ findings: result.findings.length }, "review completed")
    } catch (error) {
      if (error instanceof PullRequestHeadChangedError && checkRunId) {
        await this.github.cancelCheck(job, checkRunId, "A newer pull request revision is available.")
        await this.database.finish(job.id, "cancelled", "Pull request head changed")
        return
      }
      if (error instanceof AmpReviewCancelledError) {
        if (checkRunId) {
          await this.github.cancelCheck(job, checkRunId, "The Amp review was cancelled.")
        }
        await this.database.finish(job.id, "cancelled", errorMessage(error))
        return
      }
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
            ["threads", "archive", job.ampThreadId],
            { timeout: 30_000 },
          )
        } catch (error) {
          log.warn({ err: error, threadId: job.ampThreadId }, "failed to archive Amp review thread")
        }
      }
      clearTimeout(timeout)
      clearInterval(cancellationPoll)
      this.active.delete(controller)
    }
  }
}

class PullRequestHeadChangedError extends Error {}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8_000)
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"))
      return
    }
    const timeout = setTimeout(done, milliseconds)
    signal?.addEventListener("abort", aborted, { once: true })

    function done(): void {
      signal?.removeEventListener("abort", aborted)
      resolve()
    }

    function aborted(): void {
      clearTimeout(timeout)
      reject(signal?.reason ?? new Error("Aborted"))
    }
  })
}
