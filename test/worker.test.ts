import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ExecuteOptions, StreamMessage } from "@ampcode/sdk"
import pino from "pino"
import { executeReviewWithRetries, isTransientAmpError } from "../src/worker.js"

const validResult = JSON.stringify({ summary: "Review complete", findings: [] })
const threadId = "T-00000000-0000-0000-0000-000000000001"

describe("executeReviewWithRetries", () => {
  it("sets the title when creating the review thread", async () => {
    const fake = fakeExecute([[systemMessage(), successMessage(validResult)]])

    await run(fake.execute)

    assert.equal(fake.calls[0]?.options?.title, "Review lox/example#42")
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

describe("isTransientAmpError", () => {
  it("recognizes bounded transport and service failures", () => {
    assert.equal(isTransientAmpError(new Error("read ECONNRESET")), true)
    assert.equal(isTransientAmpError(new Error("HTTP 429 from provider")), true)
    assert.equal(isTransientAmpError(new Error("provider temporarily unavailable")), true)
    assert.equal(isTransientAmpError(new Error("thread is still running")), true)
    assert.equal(isTransientAmpError(new Error("error_max_turns")), false)
    assert.equal(isTransientAmpError(new Error("invalid project")), false)
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

function fakeExecute(attempts: StreamMessage[][]): {
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
        yield* messages
      })()
    },
  }
}

function systemMessage(): StreamMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: threadId,
    cwd: "/workspace",
    tools: [],
    mcp_servers: [],
  }
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

function successMessage(result: string): StreamMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: threadId,
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
