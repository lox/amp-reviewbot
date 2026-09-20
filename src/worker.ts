import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { execute } from "@ampcode/sdk"
import type { StreamMessage } from "@ampcode/sdk"
import type { Logger } from "pino"
import { agentModeFromMessage, reviewMode } from "./amp.js"
import { resolveAmpProject, type Config } from "./config.js"
import { Database, type PendingThreadCleanup } from "./database.js"
import { GitHubClient, type OpenPullRequest } from "./github.js"
import { buildReviewPrompt, currentReviewPromptIdentifier, parseReviewResult, reviewThreadTitle } from "./review.js"
import { readThreadUsage, type ThreadUsageLookup } from "./thread-usage.js"
import type { ReviewJob } from "./types.js"

const ampRetryDelaysMs = [5_000, 20_000]
const staleRecoveryIntervalMs = 60_000
const maxJobAttempts = 3
const threadCleanupBatchSize = 20
const threadCleanupAttemptsWhileReviewsWait = 2
const threadCleanupIntervalMs = 60_000
const reconcileIntervalMs = 5 * 60_000
// A head pushed more recently than this may still have its webhook in flight.
const reconcileMinimumAgeMs = 5 * 60_000
// Older pull requests predate the gap being repaired; a missed webhook is
// noticed well within a week.
const reconcileMaximumAgeMs = 7 * 24 * 60 * 60_000
const reconcileBatchSize = 10
const defaultRetryPrompt =
  "Complete the review if necessary, then return only the final review JSON in the required schema."

type ExecuteAmp = typeof execute
type ArchiveThread = (threadId: string) => Promise<void>

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
  continueThreadId?: string
  retryPrompt?: string
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
  continueThreadId,
  retryPrompt = defaultRetryPrompt,
}: ExecuteReviewOptions): Promise<string> {
  let threadId = continueThreadId
  let firstExecution = true

  for (let attempt = 0; ; attempt += 1) {
    let assistantFallback: string | undefined
    try {
      const continuing = threadId !== undefined
      const retryingInThread = continuing && !firstExecution
      const executionPrompt = retryingInThread ? retryPrompt : prompt
      firstExecution = false
      for await (const message of executeAmp({
        prompt: executionPrompt,
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
            // Amp has been seen to resume a retried thread in its default mode
            // rather than the pinned one. The work in that thread cannot be
            // trusted, so restart the review in a fresh thread instead.
            if (retryingInThread) {
              throw new ContinuedThreadModeError(
                `Amp continued thread ${threadId} in an unexpected mode; expected ${reviewMode}`,
              )
            }
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
      if (error instanceof ContinuedThreadModeError) {
        logger.warn({ err: error, attempt: attempt + 1, delayMs }, "restarting Amp review in a fresh thread")
        threadId = undefined
      } else {
        logger.warn({ err: error, attempt: attempt + 1, delayMs }, "retrying Amp review")
      }
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

/** An Amp failure worth retrying: the review can be run again in the same or a fresh thread. */
export class TransientAmpError extends Error {}
class ContinuedThreadModeError extends TransientAmpError {}
class ReviewCallbackError extends Error {}
class AmpReviewCancelledError extends Error {}

export function isAmpCancellationError(error: unknown): boolean {
  return /\buser cancel(?:l)?ed\b|\bcancel(?:l)?ed by (?:the )?user\b/i.test(errorMessage(error))
}

export function isTransientAmpError(error: unknown): boolean {
  if (error instanceof TransientAmpError) return true
  const message = errorMessage(error)
  return [
    /websocket closed/i,
    /websocket.*\b(?:1006|1011|1012|1013)\b/i,
    /unexpected error inside amp cli/i,
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
  private readonly promptIdentifier: string
  private readonly activeDrainWaiters = new Set<() => void>()
  private cleanupBarrier: Promise<void> | undefined
  private reviewsWaiting = 0

  constructor(
    private readonly config: Config,
    private readonly database: Database,
    private readonly github: GitHubClient,
    private readonly logger: Logger,
    private readonly readUsage: typeof readThreadUsage = readThreadUsage,
    private readonly archiveThread: ArchiveThread = archiveReviewThread,
  ) {
    this.promptIdentifier = currentReviewPromptIdentifier(config.failOn)
  }

  start(): void {
    for (let index = 0; index < this.config.workerConcurrency; index += 1) {
      this.loops.push(this.loop(index))
    }
    this.loops.push(this.recoveryLoop())
    this.loops.push(this.cleanupLoop())
    this.loops.push(this.reconcileLoop())
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
        await this.closeOrphanedDuplicateChecks()
      } catch (error) {
        this.logger.error({ err: error }, "duplicate review check cleanup failed")
      }

      try {
        await sleep(staleRecoveryIntervalMs, this.recoveryController.signal)
      } catch {
        if (this.stopping) return
        throw new Error("Stale review recovery interrupted")
      }
    }
  }

  /**
   * Migration 004 cancels surplus in-flight duplicates in SQL so that its
   * unique index always builds; a duplicate that was running, or requeued with
   * its check, leaves a GitHub check nobody else will finish. Close those here
   * rather than during startup, so a GitHub outage cannot keep the service
   * from coming up. A failure is logged and retried on the next pass.
   */
  private async closeOrphanedDuplicateChecks(): Promise<void> {
    for (const job of await this.database.orphanedDuplicateChecks()) {
      try {
        await this.github.cancelCheck(
          job,
          job.checkRunId!,
          "A duplicate review for this revision was already in progress.",
        )
        await this.database.markDuplicateCheckClosed(job.id)
        this.logger.warn({ jobId: job.id, checkRunId: job.checkRunId }, "closed check of a cancelled duplicate review")
      } catch (error) {
        this.logger.error({ err: error, jobId: job.id }, "failed to close check of a cancelled duplicate review")
      }
    }
  }

  private async cleanupLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await sleep(threadCleanupIntervalMs, this.recoveryController.signal)
      } catch (error) {
        if (this.stopping) return
        throw new Error("Thread cleanup interrupted", { cause: error })
      }

      try {
        await this.collectPendingThreadCleanup()
      } catch (error) {
        this.logger.error({ err: error }, "thread cleanup for finished reviews failed")
      }
    }
  }

  /**
   * GitHub does not retry webhook deliveries that fail, and a deploy restarts
   * the only listener. Periodically list the open pull requests this app can
   * see and queue a review for any head that has no job at all.
   */
  private async reconcileLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.reconcileMissingReviews()
      } catch (error) {
        this.logger.error({ err: error }, "review reconciliation failed")
      }

      try {
        await sleep(reconcileIntervalMs, this.recoveryController.signal)
      } catch {
        if (this.stopping) return
        throw new Error("Review reconciliation interrupted")
      }
    }
  }

  /**
   * Only repositories that have already sent this service a webhook are
   * reconciled, so installing the app on a repository with a long backlog of
   * open pull requests does not review all of them. Each repository is listed
   * on its own; one that can no longer be read (uninstalled, suspended,
   * renamed) is logged and skipped rather than ending the pass.
   */
  private async reconcileMissingReviews(now: () => number = Date.now): Promise<void> {
    let queued = 0
    for (const repository of await this.database.knownRepositories()) {
      if (this.stopping || queued >= reconcileBatchSize) return
      let pulls: OpenPullRequest[]
      try {
        pulls = await this.github.openPullRequests(repository)
      } catch (error) {
        this.logger.warn(
          { err: error, repository: repository.repositoryFullName },
          "could not list pull requests for reconciliation",
        )
        continue
      }
      for (const pull of pulls) {
        if (this.stopping || queued >= reconcileBatchSize) return
        const age = now() - pull.updatedAt.getTime()
        if (age < reconcileMinimumAgeMs || age > reconcileMaximumAgeMs) continue
        const job = await this.database.enqueueMissing({
          sourceDeliveryId: `reconcile:${repository.repositoryId}:${pull.pullNumber}:${pull.headSha}`,
          eventType: "reconcile.missing_review",
          installationId: repository.installationId,
          repositoryId: repository.repositoryId,
          repositoryFullName: repository.repositoryFullName,
          pullNumber: pull.pullNumber,
          baseSha: pull.baseSha,
          headSha: pull.headSha,
          ampProject: resolveAmpProject(this.config, repository.repositoryFullName),
          pullRequestContext: pull.pullRequestContext,
        })
        if (job) {
          queued += 1
          this.logger.warn(
            { jobId: job.id, repository: job.repositoryFullName, pr: job.pullNumber, headSha: job.headSha },
            "review queued by reconciliation; no webhook delivery reached this service",
          )
        }
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
        if (this.cleanupBarrier) {
          this.reviewsWaiting += 1
          try {
            await this.cleanupBarrier
          } finally {
            this.reviewsWaiting -= 1
          }
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

  /**
   * Why this job no longer deserves a review, or null while it still does.
   * A reconciled job comes from a listing that may be seconds stale, so the
   * pull request is re-read rather than trusted.
   */
  private async staleReason(job: ReviewJob): Promise<StaleReason | null> {
    const head = await this.github.currentHead(job)
    if (head === null) return notReviewable
    if (head !== job.headSha) return headChanged
    return null
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

      const staleBeforeReview = await this.staleReason(job)
      if (staleBeforeReview) {
        await this.github.cancelCheck(job, activeCheckRunId, staleBeforeReview.check)
        await this.database.finish(job.id, "cancelled", staleBeforeReview.job)
        return
      }

      const finalText = await executeReviewWithRetries({
        prompt: buildReviewPrompt(job, { failOn: this.config.failOn }),
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
          const stale = await this.staleReason(job)
          if (stale) throw new PullRequestStaleError(stale)
        },
      })

      if ((await this.database.status(job.id)) === "cancelled") throw new Error("Review superseded")
      const staleAfterReview = await this.staleReason(job)
      if (staleAfterReview) {
        await this.github.cancelCheck(job, activeCheckRunId, staleAfterReview.check)
        await this.database.finish(job.id, "cancelled", staleAfterReview.job)
        return
      }

      const result = parseReviewResult(finalText)
      const changedLines = await this.github.changedLines(job)
      controller.signal.throwIfAborted()
      const finalized = await this.github.completeCheck(job, activeCheckRunId, result, changedLines)
      try {
        await this.database.setResult(job.id, finalized, {
          failOn: this.config.failOn,
          promptIdentifier: this.promptIdentifier,
        })
      } catch (error) {
        // The check is already published; a missing result row only weakens monitoring.
        log.warn({ err: error }, "failed to record review result")
      }
      await this.database.finish(job.id, "succeeded")
      log.info(
        {
          conclusion: finalized.conclusion,
          findings: finalized.result.findings.length,
          blocking: finalized.blocking,
          omitted: finalized.omitted,
        },
        "review completed",
      )
    } catch (error) {
      if (error instanceof PullRequestStaleError && checkRunId) {
        await this.github.cancelCheck(job, checkRunId, error.reason.check)
        await this.database.finish(job.id, "cancelled", error.reason.job)
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
      clearTimeout(timeout)
      clearInterval(cancellationPoll)
      this.active.delete(controller)
      if (this.active.size === 0) {
        for (const resolve of this.activeDrainWaiters) resolve()
        this.activeDrainWaiters.clear()
      }
    }
  }

  private async cleanupThread(cleanup: PendingThreadCleanup, log: Logger): Promise<boolean> {
    await this.database.setThreadCleanupAttempted(cleanup.threadId)
    if (cleanup.needsArchive) {
      try {
        await this.archiveThread(cleanup.threadId)
        await this.database.setThreadArchived(cleanup.threadId)
      } catch (error) {
        log.warn({ err: error, threadId: cleanup.threadId }, "failed to archive Amp review thread")
        return false
      }
    }
    if (cleanup.needsUsage) await this.collectThreadUsage(cleanup.threadId, log)
    return true
  }

  /**
   * Looks up and stores what Amp billed for one review thread. A failed lookup
   * is stored as the error so the thread is not retried forever. A failed
   * database write stores nothing, so the row stays uncollected and the usage
   * cleanup retries it instead of losing a lookup that succeeded.
   */
  private async collectThreadUsage(threadId: string, log: Logger): Promise<void> {
    let lookup: ThreadUsageLookup
    try {
      lookup = await this.readUsage(threadId)
    } catch (error) {
      lookup = { unavailable: errorMessage(error) }
    }

    try {
      if ("usage" in lookup) {
        await this.database.setThreadUsage(threadId, lookup.usage)
        log.info(
          {
            threadId,
            ampUsageUsd: lookup.usage.costUsd,
            estimatedProviderCostAtListPriceUsd: lookup.usage.estimatedProviderCostAtListPriceUsd,
          },
          "Amp review usage collected",
        )
      } else {
        log.warn({ threadId, reason: lookup.unavailable }, "Amp review usage unavailable")
        await this.database.setThreadUsageError(threadId, lookup.unavailable)
      }
    } catch (error) {
      log.warn({ err: error, threadId }, "failed to persist Amp review usage; it will be retried")
    }
  }

  private async collectPendingThreadCleanup(): Promise<void> {
    await this.withCleanupBarrier(async () => {
      await this.waitForActiveReviews()
      if (this.stopping) return
      const pending = await this.database.pendingThreadCleanup(threadCleanupBatchSize)
      if (pending.length === 0) return
      this.logger.warn({ threads: pending.length }, "cleaning up Amp review threads left by a worker")
      let attemptsWhileReviewsWait = 0
      for (const cleanup of pending) {
        if (this.stopping) return
        const completed = await this.cleanupThread(cleanup, this.logger)
        if (this.reviewsWaiting > 0) {
          attemptsWhileReviewsWait += 1
          if (completed || attemptsWhileReviewsWait >= threadCleanupAttemptsWhileReviewsWait) return
        }
      }
    })
  }

  private async waitForActiveReviews(): Promise<void> {
    if (this.active.size === 0) return
    await new Promise<void>((resolve) => this.activeDrainWaiters.add(resolve))
  }

  private async withCleanupBarrier(operation: () => Promise<void>): Promise<void> {
    let release = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    this.cleanupBarrier = barrier
    try {
      await operation()
    } finally {
      release()
      if (this.cleanupBarrier === barrier) this.cleanupBarrier = undefined
    }
  }
}

async function archiveReviewThread(threadId: string): Promise<void> {
  await runArchiveCommand(
    resolve("node_modules", ".bin", "amp"),
    ["threads", "archive", threadId],
  )
}

export function runArchiveCommand(command: string, args: string[], timeoutMs = 30_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error(`Archive command timed out after ${timeoutMs}ms: ${stderr || stdout}`))
    }, timeoutMs)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      if (stdout.includes("Thread archived successfully")) {
        child.kill()
        finish()
      }
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", finish)
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish()
      } else {
        finish(new Error(`Archive command exited with ${signal ?? `code ${code}`}: ${stderr || stdout}`))
      }
    })

    function finish(error?: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolvePromise()
    }
  })
}

type StaleReason = { check: string; job: string }

const headChanged: StaleReason = {
  check: "A newer pull request revision is available.",
  job: "Pull request head changed",
}
const notReviewable: StaleReason = {
  check: "The pull request is closed or a draft.",
  job: "Pull request closed or converted to draft",
}

class PullRequestStaleError extends Error {
  constructor(readonly reason: StaleReason) {
    super(reason.job)
  }
}

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
