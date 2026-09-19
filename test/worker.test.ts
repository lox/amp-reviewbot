import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ExecuteOptions, StreamMessage } from "@ampcode/sdk"
import pino from "pino"
import { reviewMode } from "../src/amp.js"
import type { Database, KnownRepository, NewReviewJob } from "../src/database.js"
import type { GitHubClient, OpenPullRequest } from "../src/github.js"
import type { ThreadUsage } from "../src/thread-usage.js"
import type { ReviewJob } from "../src/types.js"
import {
  executeReviewWithRetries,
  isAmpCancellationError,
  isTransientAmpError,
  ReviewWorkers,
} from "../src/worker.js"

const validResult = JSON.stringify({ summary: "Review complete", findings: [] })
const threadId = "T-00000000-0000-0000-0000-000000000001"

describe("executeReviewWithRetries", () => {
  it("sets the title when creating the review thread", async () => {
    const fake = fakeExecute([[systemMessage(), successMessage(validResult)]])

    await run(fake.execute)

    assert.equal(fake.calls[0]?.options?.title, "Review lox/example#42")
    assert.equal(fake.calls[0]?.options?.executor, "orb")
    assert.equal(fake.calls[0]?.options?.project, "lox/example")
    assert.equal(fake.calls[0]?.options?.mode, "reviewbot-v1")
    assert.equal(fake.calls[0]?.options?.continue, undefined)
  })

  it("rejects a review that did not start in the pinned mode", async () => {
    const fake = fakeExecute([[systemMessage("medium"), successMessage(validResult)]])

    await assert.rejects(() => run(fake.execute), /expected reviewbot-v1/)
    assert.equal(fake.calls.length, 1)
  })

  it("starts evaluation reviews from an explicit no-project directory", async () => {
    const fake = fakeExecute([[systemMessage(), successMessage(validResult)]])

    await executeReviewWithRetries({
      prompt: "Review this pull request",
      title: "Review lox/example#42",
      cwd: "/tmp/empty-review-workspace",
      visibility: "private",
      signal: new AbortController().signal,
      logger: pino({ level: "silent" }),
      onThread: async () => {},
      beforeRetry: async () => {},
      executeAmp: fake.execute,
      retryDelaysMs: [0, 0],
    })

    assert.equal(fake.calls[0]?.options?.executor, "orb")
    assert.equal(fake.calls[0]?.options?.cwd, "/tmp/empty-review-workspace")
    assert.equal(fake.calls[0]?.options?.project, undefined)
  })

  it("uses the requested prompt when continuing a prepared review thread", async () => {
    const fake = fakeExecute([[systemMessage(), successMessage(validResult)]])

    const result = await executeReviewWithRetries({
      prompt: "Review the prepared source",
      title: "Review lox/example#42",
      cwd: "/tmp/empty-review-workspace",
      visibility: "private",
      signal: new AbortController().signal,
      logger: pino({ level: "silent" }),
      onThread: async () => {},
      beforeRetry: async () => {},
      continueThreadId: threadId,
      executeAmp: fake.execute,
      retryDelaysMs: [0, 0],
    })

    assert.equal(result, validResult)
    assert.equal(fake.calls[0]?.prompt, "Review the prepared source")
    assert.equal(fake.calls[0]?.options?.continue, threadId)
    assert.equal(fake.calls[0]?.options?.title, undefined)
  })

  it("keeps no-project retries outside the local repository and uses their prompt", async () => {
    const fake = fakeExecute([
      [systemMessage(), errorMessage("OpenAI WebSocket closed: 1011")],
      [systemMessage(), successMessage(validResult)],
    ])

    await executeReviewWithRetries({
      prompt: "Review this pull request",
      title: "Review lox/example#42",
      cwd: "/tmp/empty-review-workspace",
      visibility: "private",
      signal: new AbortController().signal,
      logger: pino({ level: "silent" }),
      onThread: async () => {},
      beforeRetry: async () => {},
      executeAmp: fake.execute,
      retryDelaysMs: [0, 0],
      retryPrompt: "Complete source setup only",
    })

    assert.equal(fake.calls[1]?.options?.continue, threadId)
    assert.equal(fake.calls[1]?.options?.cwd, "/tmp/empty-review-workspace")
    assert.equal(fake.calls[1]?.options?.project, undefined)
    assert.equal(fake.calls[1]?.prompt, "Complete source setup only")
  })

  it("uses a valid final assistant response when the result stream fails", async () => {
    const fake = fakeExecute([
      [systemMessage(), assistantMessage(validResult), errorMessage("OpenAI WebSocket closed: 1006")],
    ])

    const result = await run(fake.execute)

    assert.equal(result, validResult)
    assert.equal(fake.calls.length, 1)
  })

  it("continues the same thread after a transient failure", async () => {
    const fake = fakeExecute([
      [systemMessage(), errorMessage("OpenAI WebSocket closed: 1011")],
      [systemMessage(), successMessage(validResult)],
    ])
    let retries = 0

    const result = await run(fake.execute, () => {
      retries += 1
    })

    assert.equal(result, validResult)
    assert.equal(retries, 1)
    assert.equal(fake.calls.length, 2)
    assert.equal(fake.calls[1]?.options?.continue, threadId)
    assert.equal(fake.calls[1]?.options?.title, undefined)
    assert.match(String(fake.calls[1]?.prompt), /return only the final review JSON/i)
  })

  it("restarts in a fresh thread when the continued thread resumes in another mode", async () => {
    const secondThreadId = "T-00000000-0000-0000-0000-000000000002"
    const fake = fakeExecute([
      [systemMessage(), errorMessage("OpenAI WebSocket closed: 1006")],
      [systemMessage("medium")],
      [systemMessage(reviewMode, secondThreadId), successMessage(validResult, secondThreadId)],
    ])
    const threads: string[] = []

    const result = await executeReviewWithRetries({
      prompt: "Review this pull request",
      title: "Review lox/example#42",
      project: "lox/example",
      visibility: "private",
      signal: new AbortController().signal,
      logger: pino({ level: "silent" }),
      onThread: async (id) => {
        threads.push(id)
      },
      beforeRetry: async () => {},
      executeAmp: fake.execute,
      retryDelaysMs: [0, 0],
    })

    assert.equal(result, validResult)
    assert.deepEqual(threads, [threadId, secondThreadId])
    assert.equal(fake.calls[1]?.options?.continue, threadId)
    assert.equal(fake.calls[2]?.options?.continue, undefined)
    assert.equal(fake.calls[2]?.options?.mode, reviewMode)
    assert.equal(fake.calls[2]?.options?.title, "Review lox/example#42")
    assert.equal(fake.calls[2]?.prompt, "Review this pull request")
  })

  it("stops after three transiently failed executions", async () => {
    const fake = fakeExecute([
      [systemMessage(), errorMessage("OpenAI WebSocket closed: 1006")],
      [systemMessage(), errorMessage("OpenAI WebSocket closed: 1006")],
      [systemMessage(), errorMessage("OpenAI WebSocket closed: 1006")],
    ])

    await assert.rejects(() => run(fake.execute), /WebSocket closed: 1006/)
    assert.equal(fake.calls.length, 3)
  })

  it("does not retry non-transient execution errors", async () => {
    const fake = fakeExecute([[systemMessage(), errorMessage("Authentication failed")]])

    await assert.rejects(() => run(fake.execute), /Authentication failed/)
    assert.equal(fake.calls.length, 1)
  })

  it("does not retry a review cancelled from the Amp thread", async () => {
    const fake = fakeExecute([[systemMessage(), errorMessage("User canceled")]])

    await assert.rejects(() => run(fake.execute), /User canceled/)
    assert.equal(fake.calls.length, 1)
  })

  it("rejects a successful result delivered after cancellation", async () => {
    const controller = new AbortController()
    const fake = fakeExecute([[systemMessage(), successMessage(validResult)]], () => {
      controller.abort(new Error("Review timed out"))
    })

    await assert.rejects(
      () =>
        executeReviewWithRetries({
          prompt: "Review this pull request",
          title: "Review lox/example#42",
          project: "lox/example",
          visibility: "private",
          signal: controller.signal,
          logger: pino({ level: "silent" }),
          onThread: async () => {},
          beforeRetry: async () => {},
          executeAmp: fake.execute,
          retryDelaysMs: [0, 0],
        }),
      /Review timed out/,
    )
  })

  it("does not treat thread persistence failures as Amp transport failures", async () => {
    const fake = fakeExecute([[systemMessage()]])

    await assert.rejects(
      () =>
        executeReviewWithRetries({
          prompt: "Review this pull request",
          title: "Review lox/example#42",
          project: "lox/example",
          visibility: "private",
          signal: new AbortController().signal,
          logger: pino({ level: "silent" }),
          onThread: async () => {
            throw new Error("Database ETIMEDOUT")
          },
          beforeRetry: async () => {},
          executeAmp: fake.execute,
          retryDelaysMs: [0, 0],
        }),
      /Failed to persist Amp thread/,
    )
    assert.equal(fake.calls.length, 1)
  })
})

describe("cleanup for finished review threads", () => {
  const usage: ThreadUsage = {
    costUsd: 0.5,
    inputTokens: 10,
    outputTokens: 5,
    requests: 1,
    subscriptionUsed: false,
  }

  function workersWith(
    pending: Array<{ threadId: string; needsArchive: boolean; needsUsage: boolean }>,
    lookups: Record<string, { usage: ThreadUsage } | { unavailable: string }>,
    options: { failWritesFor?: string[]; failArchiveFor?: string[] } = {},
  ) {
    const stored: Array<{ threadId: string; usage?: ThreadUsage; error?: string }> = []
    const archived: string[] = []
    const requests: number[] = []
    const database = {
      async pendingThreadCleanup(limit: number) {
        requests.push(limit)
        return pending
      },
      async setThreadArchived(threadId: string) {
        archived.push(threadId)
      },
      async setThreadUsage(threadId: string, collected: ThreadUsage) {
        if (options.failWritesFor?.includes(threadId)) throw new Error("connection terminated unexpectedly")
        stored.push({ threadId, usage: collected })
      },
      async setThreadUsageError(threadId: string, error: string) {
        stored.push({ threadId, error })
      },
    } as unknown as Database
    const looked: string[] = []
    const workers = new ReviewWorkers(
      { workerConcurrency: 1, reviewTimeoutMs: 1 } as never,
      database,
      {} as GitHubClient,
      pino({ level: "silent" }),
      async (threadId) => {
        looked.push(threadId)
        return lookups[threadId] ?? { unavailable: "not stubbed" }
      },
      async (threadId) => {
        if (options.failArchiveFor?.includes(threadId)) throw new Error("archive timed out")
      },
    )
    return { workers, stored, looked, archived, requests }
  }

  it("archives threads an interrupted worker left behind and collects their usage", async () => {
    const pending = [
      { threadId: "T-done", needsArchive: true, needsUsage: true },
      { threadId: "T-gone", needsArchive: true, needsUsage: true },
    ]
    const { workers, stored, looked, archived, requests } = workersWith(pending, {
      "T-done": { usage },
      "T-gone": { unavailable: "Usage information is currently unavailable for this thread" },
    })

    await (workers as unknown as { collectPendingThreadCleanup(): Promise<void> }).collectPendingThreadCleanup()

    assert.deepEqual(requests, [20], "one bounded batch per recovery pass")
    assert.deepEqual(archived, ["T-done", "T-gone"])
    assert.deepEqual(looked, ["T-done", "T-gone"])
    assert.deepEqual(stored, [
      { threadId: "T-done", usage },
      { threadId: "T-gone", error: "Usage information is currently unavailable for this thread" },
    ])
  })

  it("blocks new reviews, drains active reviews, and still makes cleanup progress", async () => {
    const { workers, archived, looked, stored } = workersWith(
      [
        { threadId: "T-pending", needsArchive: true, needsUsage: true },
        { threadId: "T-next", needsArchive: true, needsUsage: true },
      ],
      { "T-pending": { usage }, "T-next": { usage } },
    )
    const state = workers as unknown as {
      active: Set<AbortController>
      activeDrainWaiters: Set<() => void>
      cleanupBarrier?: Promise<void>
      reviewsWaiting: number
      collectPendingThreadCleanup(): Promise<void>
    }
    const activeReview = new AbortController()
    state.active.add(activeReview)

    const cleanup = state.collectPendingThreadCleanup()
    await Promise.resolve()
    assert.ok(state.cleanupBarrier, "the claim barrier is established before active reviews drain")
    assert.deepEqual(archived, [])

    state.reviewsWaiting = 1
    state.active.delete(activeReview)
    for (const resolve of state.activeDrainWaiters) resolve()
    state.activeDrainWaiters.clear()
    await cleanup

    assert.deepEqual(archived, ["T-pending"], "a saturated queue cannot starve archival")
    assert.deepEqual(looked, [], "cleanup yields before usage or another archival can age a claimed review")
    assert.deepEqual(stored, [])
  })

  it("leaves a thread uncollected when storing valid usage fails, so it is retried instead of recorded as an error", async () => {
    const { workers, stored, looked } = workersWith(
      [
        { threadId: "T-flaky", needsArchive: false, needsUsage: true },
        { threadId: "T-fine", needsArchive: false, needsUsage: true },
      ],
      { "T-flaky": { usage }, "T-fine": { usage } },
      { failWritesFor: ["T-flaky"] },
    )

    await (workers as unknown as { collectPendingThreadCleanup(): Promise<void> }).collectPendingThreadCleanup()

    assert.deepEqual(looked, ["T-flaky", "T-fine"], "one failed write does not stop the batch")
    assert.deepEqual(stored, [{ threadId: "T-fine", usage }], "no usage_error row masks the valid usage")
  })

  it("does nothing when every finished thread is already cleaned up", async () => {
    const { workers, stored, looked } = workersWith([], {})

    await (workers as unknown as { collectPendingThreadCleanup(): Promise<void> }).collectPendingThreadCleanup()

    assert.deepEqual(looked, [])
    assert.deepEqual(stored, [])
  })

  it("stops collecting once the service is shutting down", async () => {
    const { workers, stored } = workersWith(
      [
        { threadId: "T-1", needsArchive: true, needsUsage: true },
        { threadId: "T-2", needsArchive: true, needsUsage: true },
      ],
      { "T-1": { usage }, "T-2": { usage } },
    )
    await workers.stop()

    await (workers as unknown as { collectPendingThreadCleanup(): Promise<void> }).collectPendingThreadCleanup()

    assert.deepEqual(stored, [], "a stopping worker leaves the backlog for the next process")
  })

  it("leaves archival and usage pending when archival fails", async () => {
    const { workers, archived, stored, looked } = workersWith(
      [{ threadId: "T-flaky", needsArchive: true, needsUsage: true }],
      { "T-flaky": { usage } },
      { failArchiveFor: ["T-flaky"] },
    )

    await (workers as unknown as { collectPendingThreadCleanup(): Promise<void> }).collectPendingThreadCleanup()

    assert.deepEqual(archived, [], "the database must not claim failed archival succeeded")
    assert.deepEqual(looked, [], "usage stays retryable instead of timing out behind failed archival")
    assert.deepEqual(stored, [])
  })
})

describe("missing review reconciliation", () => {
  const minute = 60_000
  const now = Date.parse("2026-09-19T12:00:00Z")
  const example: KnownRepository = { installationId: "1", repositoryId: "2", repositoryFullName: "lox/example" }
  const other: KnownRepository = { installationId: "1", repositoryId: "9", repositoryFullName: "lox/other" }

  function pull(overrides: Partial<OpenPullRequest> & { pullNumber: number }): OpenPullRequest {
    return {
      baseSha: "base",
      headSha: `head-${overrides.pullNumber}`,
      updatedAt: new Date(now - 30 * minute),
      pullRequestContext: { title: "Change", body: null, baseRef: "main", headRef: "topic" },
      ...overrides,
    }
  }

  function workersWith(
    repositories: KnownRepository[],
    pullsFor: (repository: KnownRepository) => Promise<OpenPullRequest[]>,
  ) {
    const enqueued: NewReviewJob[] = []
    const listed: string[] = []
    const database = {
      async knownRepositories() {
        return repositories
      },
      async enqueueMissing(input: NewReviewJob) {
        enqueued.push(input)
        return { ...input, id: String(enqueued.length), checkRunId: null, ampThreadId: null, status: "queued", attempts: 0 }
      },
    } as unknown as Database
    const github = {
      async openPullRequests(repository: KnownRepository) {
        listed.push(repository.repositoryFullName)
        return pullsFor(repository)
      },
    } as unknown as GitHubClient
    const workers = new ReviewWorkers(
      { workerConcurrency: 1, reviewTimeoutMs: 1, failOn: "high", ampProjects: { "lox/example": "lox/example-project" } } as never,
      database,
      github,
      pino({ level: "silent" }),
      async () => ({ unavailable: "not used" }),
    )
    const reconcile = () =>
      (workers as unknown as { reconcileMissingReviews(now: () => number): Promise<void> }).reconcileMissingReviews(
        () => now,
      )
    return { reconcile, enqueued, listed }
  }

  it("queues heads old enough to have missed their webhook but not stale, from the repository's last known coordinates", async () => {
    const { reconcile, enqueued } = workersWith([example], async () => [
      pull({ pullNumber: 1 }),
      pull({ pullNumber: 2, updatedAt: new Date(now - 4 * minute) }),
      pull({ pullNumber: 3, updatedAt: new Date(now - 8 * 24 * 60 * minute) }),
    ])

    await reconcile()

    assert.deepEqual(
      enqueued.map((job) => job.pullNumber),
      [1],
      "a fresh push may still have its webhook in flight; a week-old head predates the gap",
    )
    const job = enqueued[0]!
    assert.equal(job.sourceDeliveryId, "reconcile:2:1:head-1")
    assert.equal(job.eventType, "reconcile.missing_review")
    assert.deepEqual(
      [job.installationId, job.repositoryId, job.repositoryFullName, job.ampProject],
      ["1", "2", "lox/example", "lox/example-project"],
    )
    assert.deepEqual(job.pullRequestContext, { title: "Change", body: null, baseRef: "main", headRef: "topic" })
  })

  it("queues at most ten reviews per pass", async () => {
    const { reconcile, enqueued } = workersWith([example], async () =>
      Array.from({ length: 12 }, (_, index) => pull({ pullNumber: index + 1 })),
    )

    await reconcile()

    assert.equal(enqueued.length, 10)
  })

  it("skips a repository it can no longer list and continues with the rest", async () => {
    const { reconcile, enqueued, listed } = workersWith([other, example], async (repository) => {
      if (repository === other) throw new Error("installation suspended")
      return [pull({ pullNumber: 1 })]
    })

    await reconcile()

    assert.deepEqual(listed, ["lox/other", "lox/example"])
    assert.deepEqual(enqueued.map((job) => job.repositoryFullName), ["lox/example"])
  })

  it("does not list anything before any repository has sent a webhook", async () => {
    const { reconcile, enqueued, listed } = workersWith([], async () => [pull({ pullNumber: 1 })])

    await reconcile()

    assert.deepEqual(listed, [])
    assert.deepEqual(enqueued, [])
  })
})

describe("orphaned duplicate check cleanup", () => {
  function duplicate(id: string, checkRunId: string): ReviewJob {
    return {
      id,
      sourceDeliveryId: `delivery-${id}`,
      eventType: "pull_request.synchronize",
      installationId: "1",
      repositoryId: "2",
      repositoryFullName: "lox/example",
      pullNumber: 7,
      baseSha: "base",
      headSha: "head",
      ampProject: "lox/example",
      pullRequestContext: null,
      checkRunId,
      ampThreadId: null,
      status: "cancelled",
      attempts: 1,
    }
  }

  function workersWith(orphaned: ReviewJob[], options: { failCheckFor?: string[] } = {}) {
    const marked: string[] = []
    const cancelled: Array<{ jobId: string; checkRunId: string; reason: string }> = []
    const database = {
      async orphanedDuplicateChecks() {
        return orphaned
      },
      async markDuplicateCheckClosed(jobId: string) {
        marked.push(jobId)
      },
    } as unknown as Database
    const github = {
      async cancelCheck(job: ReviewJob, checkRunId: string, reason: string) {
        if (options.failCheckFor?.includes(checkRunId)) throw new Error("GitHub unavailable")
        cancelled.push({ jobId: job.id, checkRunId, reason })
      },
    } as unknown as GitHubClient
    const workers = new ReviewWorkers(
      { workerConcurrency: 1, reviewTimeoutMs: 1, failOn: "high" } as never,
      database,
      github,
      pino({ level: "silent" }),
      async () => ({ unavailable: "not used" }),
    )
    const close = () =>
      (workers as unknown as { closeOrphanedDuplicateChecks(): Promise<void> }).closeOrphanedDuplicateChecks()
    return { close, cancelled, marked }
  }

  it("closes the check of each duplicate the migration cancelled, then marks the job so it is not revisited", async () => {
    const { close, cancelled, marked } = workersWith([duplicate("10", "100"), duplicate("11", "110")])

    await close()

    assert.deepEqual(cancelled.map((call) => call.checkRunId), ["100", "110"])
    assert.match(cancelled[0]!.reason, /duplicate review for this revision/)
    assert.deepEqual(marked, ["10", "11"])
  })

  it("leaves a job unmarked when GitHub rejects the cancellation so the next pass retries it", async () => {
    const { close, cancelled, marked } = workersWith([duplicate("10", "100"), duplicate("11", "110")], {
      failCheckFor: ["100"],
    })

    await close()

    assert.deepEqual(cancelled.map((call) => call.checkRunId), ["110"])
    assert.deepEqual(marked, ["11"], "only a closed check is recorded as closed")
  })
})

describe("stale job detection", () => {
  const job = {
    id: "1",
    repositoryFullName: "lox/example",
    pullNumber: 1,
    headSha: "head-1",
  } as ReviewJob

  function staleReason(currentHead: string | null) {
    const workers = new ReviewWorkers(
      { workerConcurrency: 1, reviewTimeoutMs: 1, failOn: "high", ampProjects: {} } as never,
      {} as Database,
      { currentHead: async () => currentHead } as unknown as GitHubClient,
      pino({ level: "silent" }),
      async () => ({ unavailable: "not used" }),
    )
    return (
      workers as unknown as {
        staleReason(job: ReviewJob): Promise<{ check: string; job: string } | null>
      }
    ).staleReason(job)
  }

  it("lets a job whose head is still current proceed", async () => {
    assert.equal(await staleReason("head-1"), null)
  })

  it("cancels for a newer head, and separately for a closed or draft pull request", async () => {
    assert.equal((await staleReason("head-2"))?.check, "A newer pull request revision is available.")
    assert.equal((await staleReason(null))?.check, "The pull request is closed or a draft.")
  })
})

describe("isTransientAmpError", () => {
  it("recognizes bounded transport and service failures", () => {
    assert.equal(isTransientAmpError(new Error("read ECONNRESET")), true)
    assert.equal(isTransientAmpError(new Error("HTTP 429 from provider")), true)
    assert.equal(isTransientAmpError(new Error("provider temporarily unavailable")), true)
    assert.equal(isTransientAmpError(new Error("thread is still running")), true)
    assert.equal(isTransientAmpError(new Error("OpenAI WebSocket closed: 1000 .")), true)
    assert.equal(
      isTransientAmpError(
        new Error("Amp CLI exited with status 1: Error: Unexpected error inside Amp CLI."),
      ),
      true,
    )
    assert.equal(isTransientAmpError(new Error("error_max_turns")), false)
    assert.equal(isTransientAmpError(new Error("invalid project")), false)
  })
})

describe("isAmpCancellationError", () => {
  it("recognizes user cancellation without matching unrelated failures", () => {
    assert.equal(isAmpCancellationError(new Error("User canceled")), true)
    assert.equal(isAmpCancellationError(new Error("Cancelled by the user")), true)
    assert.equal(isAmpCancellationError(new Error("Review timed out")), false)
  })
})

async function run(
  executeAmp: ReturnType<typeof fakeExecute>["execute"],
  beforeRetry: () => void = () => {},
): Promise<string> {
  return executeReviewWithRetries({
    prompt: "Review this pull request",
    title: "Review lox/example#42",
    project: "lox/example",
    visibility: "private",
    signal: new AbortController().signal,
    logger: pino({ level: "silent" }),
    onThread: async () => {},
    beforeRetry: async () => beforeRetry(),
    executeAmp,
    retryDelaysMs: [0, 0],
  })
}

function fakeExecute(attempts: StreamMessage[][], beforeResult?: () => void): {
  execute: (options: ExecuteOptions) => AsyncIterable<StreamMessage>
  calls: ExecuteOptions[]
} {
  const calls: ExecuteOptions[] = []
  return {
    calls,
    execute(options) {
      const messages = attempts[calls.length]
      calls.push(options)
      if (!messages) throw new Error("Unexpected Amp execution")
      return (async function* () {
        for (const message of messages) {
          if (message.type === "result") beforeResult?.()
          yield message
        }
      })()
    },
  }
}

function systemMessage(agentMode: string = reviewMode, sessionId = threadId): StreamMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: "/workspace",
    agent_mode: agentMode,
    tools: [],
    mcp_servers: [],
  } as unknown as StreamMessage
}

function assistantMessage(text: string): StreamMessage {
  return {
    type: "assistant",
    session_id: threadId,
    parent_tool_use_id: null,
    message: {
      id: "message-1",
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
    },
  }
}

function successMessage(result: string, sessionId = threadId): StreamMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    result,
    duration_ms: 1,
    num_turns: 1,
  }
}

function errorMessage(error: string): StreamMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    session_id: threadId,
    is_error: true,
    error,
    duration_ms: 1,
    num_turns: 1,
  }
}
