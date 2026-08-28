import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { judgeFindings, resolveMatchingVotes } from "../eval/judge.js"
import { formatReport } from "../eval/report.js"
import {
  corpusContentHash,
  corpusSchema,
  evalCaseSchema,
  evalRunSchema,
  evalSampleSchema,
  expectedConclusion,
} from "../eval/schema.js"
import { scoreRun } from "../eval/score.js"

const lowFinding = {
  severity: "low",
  title: "Minor issue",
  message: "A rare input is handled poorly.",
  suggestion: "Handle the rare input.",
  path: "src/example.ts",
  startLine: 10,
} as const

const mediumFinding = { ...lowFinding, severity: "medium" as const }
const highFinding = { ...lowFinding, severity: "high" as const }

const artifactHash = `sha256:${"a".repeat(64)}` as const
const control = {
  kind: "control",
  issue: null,
  certification: {
    method: "llm-adjudicated",
    evidenceArtifactHash: artifactHash,
  },
} as const
const blocking = {
  kind: "blocking",
  issue: {
    id: "known-failure",
    severity: "high",
    rootCause: "The retry repeats completed work.",
    failureBehavior: "A lost response creates a duplicate object.",
    path: "src/example.ts",
    changedLine: 10,
    evidence: ["A focused witness reproduces the duplicate."],
    verification: "executable",
    witnessArtifactHash: artifactHash,
  },
} as const

describe("eval corpus", () => {
  it("accepts the documented corpus format", async () => {
    const input: unknown = JSON.parse(await readFile("eval/corpus.example.json", "utf8"))
    const corpus = corpusSchema.parse(input)

    assert.equal(corpus.cases.length, 3)
    assert.equal(
      expectedConclusion(corpus.cases.find((evalCase) => evalCase.expected.kind === "blocking")!.expected),
      "failure",
    )
  })

  it("rejects an expected issue outside the archived changed lines", async () => {
    const input = JSON.parse(await readFile("eval/corpus.example.json", "utf8")) as {
      cases: Array<{ expected: { issue: { changedLine: number } | null } }>
    }
    const mutation = input.cases.find((evalCase) => evalCase.expected.issue)!
    mutation.expected.issue!.changedLine = 999

    assert.throws(() => corpusSchema.parse(input), /archived changed line/)
  })

  it("rejects an incomplete seed triplet", async () => {
    const input = JSON.parse(await readFile("eval/corpus.example.json", "utf8")) as {
      cases: unknown[]
    }
    input.cases.pop()

    assert.throws(() => corpusSchema.parse(input), /one control, one advisory, and one blocking/)
  })

  it("requires a witness hash for executable labels", async () => {
    const input = JSON.parse(await readFile("eval/corpus.example.json", "utf8")) as {
      cases: Array<{
        expected: { issue: { verification: string; witnessArtifactHash?: string } | null }
      }>
    }
    const mutation = input.cases.find((evalCase) => evalCase.expected.issue)!
    delete mutation.expected.issue!.witnessArtifactHash

    assert.throws(() => corpusSchema.parse(input), /requires a witness artifact hash/)
  })

  it("rejects a mutation that reuses the control revision", async () => {
    const input = JSON.parse(await readFile("eval/corpus.example.json", "utf8")) as {
      cases: Array<{ headSha: string }>
    }
    input.cases[1]!.headSha = input.cases[0]!.headSha

    assert.throws(() => corpusSchema.parse(input), /distinct head SHAs/)
  })

  it("accepts samples when the runtime omits model provenance", () => {
    const sample = completed("control", 1, control, "success", [], null)
    sample.models = []

    assert.deepEqual(evalSampleSchema.parse(sample).models, [])
  })
})

describe("eval scoring", () => {
  it("averages repeated samples within each case", () => {
    const cases = [evalCase("control", control), evalCase("blocking", blocking)]
    const run = evalRunSchema.parse({
      schemaVersion: 1,
      corpusVersion: "test-v1",
      corpusHash: corpusContentHash({ version: "test-v1", cases }),
      startedAt: "2026-08-25T00:00:00.000Z",
      completedAt: "2026-08-25T00:10:00.000Z",
      requestedSamplesPerCase: 3,
      concurrency: 2,
      timeoutMs: 1_800_000,
      reviewer: {
        gitCommit: "a".repeat(40),
        dirty: false,
        sdkVersion: "test",
        mode: "medium",
        failOn: "high",
        reviewSourceHash: "source",
        methodologyHash: "methodology",
      },
      cases,
      samples: [
        completed("control", 1, control, "success", [], null),
        completed("control", 2, control, "neutral", [lowFinding], null),
        failed("control", 3, control),
        completed("blocking", 1, blocking, "failure", [highFinding], judgement([0], false)),
        completed("blocking", 2, blocking, "neutral", [mediumFinding], judgement([0], true)),
        completed("blocking", 3, blocking, "failure", [highFinding], judgement([], false)),
      ],
    })

    const score = scoreRun(run)
    const controlScore = score.cases.find((item) => item.caseId === "control")!
    const blockingScore = score.cases.find((item) => item.caseId === "blocking")!

    assert.ok(Math.abs(score.operationalCompletion - 5 / 6) < Number.EPSILON)
    assert.equal(score.conclusionAgreement, 1 / 2)
    assert.equal(score.groundedConclusionAgreement, 1 / 3)
    assert.equal(controlScore.cleanAlertRate, 1 / 2)
    assert.equal(blockingScore.issueDetectionRate, 2 / 3)
    assert.equal(blockingScore.injectionPrecision, 2 / 3)
    assert.equal(blockingScore.severityAgreement, 1 / 2)
    assert.equal(blockingScore.severityThresholdAgreement, 1 / 2)
    assert.equal(blockingScore.judgeCoverage, 1)
    assert.equal(blockingScore.judgeDisagreementRate, 1 / 3)

    const report = formatReport(run, score)
    assert.match(report, /Review evaluation: INCOMPLETE/)
    assert.match(report, /Clean change: 1 of 2 completed reviews had no false alarms/)
    assert.match(report, /Serious bug: found in 2 of 3; right response in 1 of 3/)
    assert.match(report, /This result covers only these examples/)

    const completeRun = evalRunSchema.parse({
      ...run,
      samples: [
        completed("control", 1, control, "success", [], null),
        completed("control", 2, control, "success", [], null),
        completed("control", 3, control, "success", [], null),
        completed("blocking", 1, blocking, "neutral", [mediumFinding], judgement([0], false)),
        completed("blocking", 2, blocking, "neutral", [mediumFinding], judgement([0], false)),
        completed("blocking", 3, blocking, "neutral", [mediumFinding], judgement([0], false)),
      ],
    })
    const completeReport = formatReport(completeRun, scoreRun(completeRun))
    assert.match(completeReport, /Review evaluation: NEEDS WORK/)
    assert.match(completeReport, /Serious bug: found in 3 of 3; right response in 0 of 3/)
  })

  it("does not report failed controls as clean", () => {
    const cases = [evalCase("control", control)]
    const run = evalRunSchema.parse({
      schemaVersion: 1,
      corpusVersion: "test-v1",
      corpusHash: corpusContentHash({ version: "test-v1", cases }),
      startedAt: "2026-08-25T00:00:00.000Z",
      completedAt: "2026-08-25T00:10:00.000Z",
      requestedSamplesPerCase: 1,
      concurrency: 1,
      timeoutMs: 1_800_000,
      reviewer: {
        gitCommit: "a".repeat(40),
        dirty: false,
        sdkVersion: "test",
        mode: "medium",
        failOn: "high",
        reviewSourceHash: "source",
        methodologyHash: "methodology",
      },
      cases,
      samples: [failed("control", 1, control)],
    })

    assert.equal(scoreRun(run).cleanAlertRate, null)
  })

  it("rejects a run whose embedded corpus no longer matches its hash", () => {
    const cases = [evalCase("control", control)]

    assert.throws(
      () =>
        evalRunSchema.parse({
          schemaVersion: 1,
          corpusVersion: "test-v1",
          corpusHash: artifactHash,
          startedAt: "2026-08-25T00:00:00.000Z",
          completedAt: "2026-08-25T00:10:00.000Z",
          requestedSamplesPerCase: 1,
          concurrency: 1,
          timeoutMs: 1_800_000,
          reviewer: {
            gitCommit: "a".repeat(40),
            dirty: false,
            sdkVersion: "test",
            mode: "medium",
            failOn: "high",
            reviewSourceHash: "source",
            methodologyHash: "methodology",
          },
          cases,
          samples: [completed("control", 1, control, "success", [], null)],
        }),
      /corpus hash does not match/,
    )
  })

  it("rejects a judgement that references a missing finding", () => {
    const cases = [evalCase("blocking", blocking)]
    const sample = completed(
      "blocking",
      1,
      blocking,
      "failure",
      [highFinding],
      judgement([1], false),
    )

    assert.throws(
      () =>
        evalRunSchema.parse({
          schemaVersion: 1,
          corpusVersion: "test-v1",
          corpusHash: corpusContentHash({ version: "test-v1", cases }),
          startedAt: "2026-08-25T00:00:00.000Z",
          completedAt: "2026-08-25T00:10:00.000Z",
          requestedSamplesPerCase: 1,
          concurrency: 1,
          timeoutMs: 1_800_000,
          reviewer: {
            gitCommit: "a".repeat(40),
            dirty: false,
            sdkVersion: "test",
            mode: "medium",
            failOn: "high",
            reviewSourceHash: "source",
            methodologyHash: "methodology",
          },
          cases,
          samples: [sample],
        }),
      /finding that was not retained/,
    )
  })

  it("rejects a sample conclusion that does not follow from its raw review", () => {
    const cases = [evalCase("blocking", blocking)]

    assert.throws(
      () =>
        evalRunSchema.parse({
          schemaVersion: 1,
          corpusVersion: "test-v1",
          corpusHash: corpusContentHash({ version: "test-v1", cases }),
          startedAt: "2026-08-25T00:00:00.000Z",
          completedAt: "2026-08-25T00:10:00.000Z",
          requestedSamplesPerCase: 1,
          concurrency: 1,
          timeoutMs: 1_800_000,
          reviewer: {
            gitCommit: "a".repeat(40),
            dirty: false,
            sdkVersion: "test",
            mode: "medium",
            failOn: "high",
            reviewSourceHash: "source",
            methodologyHash: "methodology",
          },
          cases,
          samples: [completed("blocking", 1, blocking, "failure", [], null)],
        }),
      /sample result does not match its raw production review/,
    )
  })
})

describe("eval judging", () => {
  it("uses a majority only for disputed finding matches", () => {
    assert.deepEqual(resolveMatchingVotes([[0, 2], [1, 2], [0, 2]]), [0, 2])
  })

  it("runs one judge per vote for concurrent identical findings", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "amp-reviewbot-eval-"))
    const release = deferred<void>()
    const started = deferred<void>()
    let calls = 0
    const executeJudge = async function* () {
      calls += 1
      started.resolve()
      await release.promise
      yield judgeResult()
    }

    try {
      const testCase = evalCaseSchema.parse(evalCase("blocking", blocking))
      const first = judgeFindings(
        testCase,
        [highFinding],
        cacheDirectory,
        "test-sdk",
        new AbortController().signal,
        executeJudge as never,
      )
      await started.promise
      const second = judgeFindings(
        testCase,
        [highFinding],
        cacheDirectory,
        "test-sdk",
        new AbortController().signal,
        executeJudge as never,
      )
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate))

      assert.equal(calls, 1)
      release.resolve()
      const results = await Promise.all([first, second])

      assert.equal(calls, 2)
      assert.deepEqual(results.map((result) => result.matchingFindingIndices), [[0], [0]])
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true })
    }
  })

  it("does not share cancellation between samples waiting for the same vote", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "amp-reviewbot-eval-"))
    const release = deferred<void>()
    const firstStarted = deferred<void>()
    const replacementStarted = deferred<void>()
    let calls = 0
    const executeJudge = async function* (input: { signal: AbortSignal }) {
      calls += 1
      if (calls === 1) firstStarted.resolve()
      if (calls === 2) replacementStarted.resolve()
      await waitForTestRelease(release.promise, input.signal)
      yield judgeResult()
    }
    const firstController = new AbortController()

    try {
      const testCase = evalCaseSchema.parse(evalCase("blocking", blocking))
      const first = judgeFindings(
        testCase,
        [highFinding],
        cacheDirectory,
        "test-sdk",
        firstController.signal,
        executeJudge as never,
      )
      await firstStarted.promise
      const second = judgeFindings(
        testCase,
        [highFinding],
        cacheDirectory,
        "test-sdk",
        new AbortController().signal,
        executeJudge as never,
      )
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate))

      firstController.abort(new Error("first sample cancelled"))
      await assert.rejects(first, /first sample cancelled/)
      await replacementStarted.promise
      release.resolve()

      assert.deepEqual((await second).matchingFindingIndices, [0])
      assert.equal(calls, 3)
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true })
    }
  })

  it("rejects a judge result delivered after cancellation", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "amp-reviewbot-eval-"))
    const release = deferred<void>()
    const started = deferred<void>()
    const controller = new AbortController()
    const executeJudge = async function* () {
      started.resolve()
      await release.promise
      yield judgeResult()
    }

    try {
      const result = judgeFindings(
        evalCaseSchema.parse(evalCase("blocking", blocking)),
        [highFinding],
        cacheDirectory,
        "test-sdk",
        controller.signal,
        executeJudge as never,
      )
      await started.promise
      controller.abort(new Error("judge timed out"))
      release.resolve()

      await assert.rejects(result, /judge timed out/)
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true })
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function judgeResult() {
  return {
    type: "result",
    is_error: false,
    result: '{"matchingFindingIndices":[0]}',
  }
}

function waitForTestRelease(release: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolveWait, rejectWait) => {
    const aborted = () => {
      cleanup()
      rejectWait(signal.reason)
    }
    const cleanup = () => signal.removeEventListener("abort", aborted)
    signal.addEventListener("abort", aborted, { once: true })
    void release.then(() => {
      cleanup()
      resolveWait()
    })
  })
}

function evalCase(id: string, expected: typeof control | typeof blocking) {
  return {
    id,
    seedId: id,
    repositoryFullName: "lox/example",
    pullNumber: 42,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    ampProject: "lox/example",
    context: {
      title: "Example change",
      body: "Exercises the eval scorer.",
      baseRef: "main",
      headRef: "example-change",
    },
    changedLines: { "src/example.ts": [10] },
    expected,
  }
}

function completed(
  caseId: string,
  sample: number,
  expected: typeof control | typeof blocking,
  conclusion: "success" | "neutral" | "failure",
  findings: Array<typeof lowFinding | typeof mediumFinding | typeof highFinding>,
  judgementResult: ReturnType<typeof judgement> | null,
) {
  const result = { summary: "Review complete", findings }
  return {
    caseId,
    sample,
    expected,
    promptHash: "prompt",
    threadId: null,
    models: ["test-reviewer"],
    durationMs: 1,
    status: "completed",
    rawResult: JSON.stringify(result),
    parsedResult: result,
    retainedResult: result,
    omitted: 0,
    conclusion,
    judgement: judgementResult,
    judgementError: null,
  }
}

function failed(caseId: string, sample: number, expected: typeof control | typeof blocking) {
  return {
    caseId,
    sample,
    expected,
    promptHash: "prompt",
    threadId: null,
    models: [],
    durationMs: 1,
    status: "error",
    error: "review failed",
  }
}

function judgement(matchingFindingIndices: number[], disagreement: boolean) {
  return {
    matchingFindingIndices,
    votes: disagreement ? [matchingFindingIndices, []] : [matchingFindingIndices, matchingFindingIndices],
    disagreement,
    models: ["test-judge"],
    provenance: {
      version: "1",
      mode: "high",
      sdkVersion: "test-sdk",
      project: "lox/example",
      promptHash: "prompt",
      schemaHash: "schema",
    },
  }
}
