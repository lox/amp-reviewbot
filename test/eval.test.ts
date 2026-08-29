import assert from "node:assert/strict"
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, it } from "node:test"
import { promisify } from "node:util"
import { judgeIssue, resolveMatchingVotes } from "../eval/judge.js"
import { checkPack, exampleSchema, loadPack } from "../eval/pack.js"
import { formatReport } from "../eval/report.js"
import {
  reviewAuthentication,
  reviewerEnvironment,
  runBlindReview,
} from "../eval/reviewer.js"
import {
  corpusContentHash,
  evalCaseSchema,
  evalRunSchema,
  evalSampleSchema,
  expectedConclusion,
  type ExpectedResult,
} from "../eval/schema.js"
import { scoreRun } from "../eval/score.js"

const execFileAsync = promisify(execFile)
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
const control: ExpectedResult = { issues: [] }
const blocking: ExpectedResult = {
  issues: [
    {
      id: "known-failure",
      severity: "high",
      rootCause: "The retry repeats completed work.",
      failureBehavior: "A lost response creates a duplicate object.",
      path: "src/example.ts",
      changedLine: 10,
      verification: "A focused test reproduces the duplicate.",
    },
  ],
}

describe("eval example packs", () => {
  it("accepts the documented minimal format without requiring a triplet", async () => {
    const input: unknown = JSON.parse(await readFile("eval/example.json", "utf8"))
    const example = exampleSchema.parse(input)
    assert.equal(example.versions.length, 3)
    assert.equal((await checkPack("eval")).summary.knownIssues, 2)

    const oneVersion = structuredClone(example)
    oneVersion.versions.splice(1)
    assert.equal(exampleSchema.parse(oneVersion).versions.length, 1)
  })

  it("rejects duplicate version commits", async () => {
    const input = JSON.parse(await readFile("eval/example.json", "utf8")) as {
      versions: Array<{ commit: string }>
    }
    input.versions[1]!.commit = input.versions[0]!.commit
    assert.throws(() => exampleSchema.parse(input), /different commit/)
  })

  it("rejects names that cannot safely form Git references", async () => {
    const input = JSON.parse(await readFile("eval/example.json", "utf8")) as { id: string }
    for (const id of ["bad..id", "bad.lock", "bad."]) {
      input.id = id
      assert.throws(() => exampleSchema.parse(input), /safe for Git references/)
    }
  })

  it("rejects a known issue outside the exact changed lines", () => {
    const invalid = evalCase("blocking", blocking)
    invalid.expected.issues[0]!.changedLine = 999
    assert.throws(() => evalCaseSchema.parse(invalid), /line changed by the exact review diff/)
  })

  it("derives changed lines and a target-only source setup from a bundle", async () => {
    const fixture = await createPackFixture()
    try {
      const loaded = await loadPack(fixture.pack, fixture.cache, () => fixture.origin)
      assert.equal(loaded.corpus.cases.length, 2)
      assert.deepEqual(
        loaded.corpus.cases.map((item) => item.changedLines),
        [{ "code.txt": [2] }, { "code.txt": [2] }],
      )
      assert.equal(expectedConclusion(loaded.corpus.cases[1]!.expected), "failure")
      assert.equal(loaded.sourcePreparation.has("local-example/clean-change"), false)
      const preparation = loaded.sourcePreparation.get("local-example/serious-bug")!
      assert.match(preparation, /source history/)
      assert.match(preparation, /base64 --decode/)
      assert.doesNotMatch(preparation, /known-bug|Loses the useful result|witnesses\//)
      const encodedBundle = /printf '%s' '([^']+)' \| base64 --decode/.exec(preparation)?.[1]
      assert.ok(encodedBundle)
      const generatedBundle = join(fixture.root, "generated.bundle")
      await writeFile(generatedBundle, Buffer.from(encodedBundle, "base64"))
      const heads = (await git(fixture.origin, ["bundle", "list-heads", generatedBundle]))
        .trim()
        .split("\n")
      assert.equal(heads.length, 1)
      assert.match(heads[0]!, new RegExp(`^${loaded.corpus.cases[1]!.headSha} `))

      await git(fixture.origin, ["tag", "public-clean", fixture.clean])
      await git(fixture.origin, ["update-ref", "refs/heads/main", fixture.base])
      const reloaded = await loadPack(fixture.pack, fixture.cache, () => fixture.origin)
      assert.equal(
        reloaded.sourcePreparation.get("local-example/serious-bug"),
        preparation,
      )

      await git(fixture.origin, ["tag", "--delete", "public-clean"])
      await assert.rejects(
        loadPack(fixture.pack, fixture.cache, () => fixture.origin),
        /not (?:reachable from a public branch or tag|public or advertised)/,
      )

      await git(fixture.origin, ["update-ref", "refs/heads/main", fixture.clean])
      await rm(join(fixture.pack, "examples", "local-example", "commits.bundle"))
      await assert.rejects(
        loadPack(fixture.pack, fixture.cache, () => fixture.origin),
        /not public or advertised by this example's commits\.bundle/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it("rejects source transfers that would make reviews too large", async () => {
    const fixture = await createPackFixture(true)
    try {
      await assert.rejects(
        loadPack(fixture.pack, fixture.cache, () => fixture.origin),
        /Generated source transfer .* the limit is 64 KiB/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it("accepts samples when the runtime omits model provenance", () => {
    const sample = completed("control", 1, control, "success", [], [])
    sample.models = []
    assert.deepEqual(evalSampleSchema.parse(sample).models, [])
  })

  it("uses local CLI authentication unless a dedicated review key is provided", () => {
    const previousApiKey = process.env.AMP_API_KEY
    const previousReviewerApiKey = process.env.AMP_EVAL_REVIEWER_API_KEY
    process.env.AMP_API_KEY = "ambient-key"
    process.env.AMP_EVAL_REVIEWER_API_KEY = "ambient-reviewer-key"
    process.env.EVAL_TEST_SECRET = "must-not-pass"
    try {
      const local = reviewerEnvironment()
      assert.equal(local.AMP_API_KEY, undefined)
      assert.equal(local.AMP_EVAL_REVIEWER_API_KEY, undefined)
      assert.equal(local.HOME, process.env.HOME)
      assert.equal(local.EVAL_TEST_SECRET, undefined)

      const keyed = reviewerEnvironment("work-key", "/tmp/empty-home")
      assert.equal(keyed.AMP_API_KEY, "work-key")
      assert.equal(keyed.HOME, "/tmp/empty-home")
      assert.equal(keyed.AMP_EVAL_REVIEWER_API_KEY, undefined)
      assert.equal(keyed.EVAL_TEST_SECRET, undefined)
    } finally {
      restoreEnvironment("AMP_API_KEY", previousApiKey)
      restoreEnvironment("AMP_EVAL_REVIEWER_API_KEY", previousReviewerApiKey)
      delete process.env.EVAL_TEST_SECRET
    }
  })

  it("waits for the reviewer child to exit and force-stops it after an input failure", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const spawned = deferred<void>()
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(signal)
        return true
      },
    }) as unknown as ChildProcessWithoutNullStreams
    const review = runBlindReview(
      {
        prompt: "Review this change.",
        title: "Test review",
        project: "test-project",
        timeoutMs: 1_000,
        apiKey: "test-key",
        signal: new AbortController().signal,
      },
      () => {
        spawned.resolve()
        return child
      },
    )
    let settled = false
    void review.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await spawned.promise
    child.stdin.emit("error", new Error("broken pipe"))
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    assert.equal(settled, false)
    assert.deepEqual(signals, ["SIGTERM"])

    context.mock.timers.tick(5_000)
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])

    child.emit("close", 1, null)
    await assert.rejects(review, /Could not send review input/)
  })

  it("records whether reviews use the local CLI or a dedicated key", async () => {
    assert.deepEqual(await reviewAuthentication(undefined), { authentication: "local-cli" })

    const separate = await reviewAuthentication(
      "reviewer-key",
      accountFetch({ "reviewer-key": "user-two" }),
    )
    assert.equal(separate.authentication, "reviewer-api-key")
    assert.match(separate.reviewerIdHash, /^sha256:[0-9a-f]{64}$/)
  })
})

describe("eval scoring", () => {
  it("averages repeated samples within each code version", () => {
    const cases = [evalCase("control", control), evalCase("blocking", blocking)]
    const run = makeRun(cases, 3, [
      completed("control", 1, control, "success", [], []),
      completed("control", 2, control, "neutral", [lowFinding], []),
      failed("control", 3, control),
      completed("blocking", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
      completed("blocking", 2, blocking, "neutral", [mediumFinding], [judgement([0], true)]),
      completed("blocking", 3, blocking, "failure", [highFinding], [judgement([], false)]),
    ])

    const score = scoreRun(run)
    const controlScore = score.cases.find((item) => item.caseId === "control")!
    const blockingScore = score.cases.find((item) => item.caseId === "blocking")!

    assert.ok(Math.abs(score.operationalCompletion - 5 / 6) < Number.EPSILON)
    assert.equal(score.conclusionAgreement, 1 / 2)
    assert.equal(score.groundedConclusionAgreement, 1 / 3)
    assert.equal(controlScore.cleanAlertRate, 1 / 2)
    assert.equal(blockingScore.issueDetectionRate, 2 / 3)
    assert.equal(blockingScore.findingPrecision, 2 / 3)
    assert.equal(blockingScore.severityAgreement, 1 / 2)
    assert.equal(blockingScore.severityThresholdAgreement, 1 / 2)
    assert.equal(blockingScore.judgeCoverage, 1)
    assert.equal(blockingScore.judgeDisagreementRate, 1 / 3)

    const report = formatReport(run, score)
    assert.match(report, /Review evaluation: INCOMPLETE/)
    assert.match(report, /Clean change: 1 of 2 completed reviews had no false alarms/)
    assert.match(report, /Serious bug: found in 2 of 3; right response in 1 of 3/)
    assert.match(report, /This result covers only these examples/)

    const completeRun = makeRun(cases, 3, [
      completed("control", 1, control, "success", [], []),
      completed("control", 2, control, "success", [], []),
      completed("control", 3, control, "success", [], []),
      completed("blocking", 1, blocking, "neutral", [mediumFinding], [judgement([0], false)]),
      completed("blocking", 2, blocking, "neutral", [mediumFinding], [judgement([0], false)]),
      completed("blocking", 3, blocking, "neutral", [mediumFinding], [judgement([0], false)]),
    ])
    const completeReport = formatReport(completeRun, scoreRun(completeRun))
    assert.match(completeReport, /Review evaluation: NEEDS WORK/)
    assert.match(completeReport, /Serious bug: found in 3 of 3; right response in 0 of 3/)
  })

  it("does not let one finding count as two known bugs", () => {
    const twoIssues: ExpectedResult = {
      issues: [
        blocking.issues[0]!,
        { ...blocking.issues[0]!, id: "second-failure" },
      ],
    }
    const cases = [evalCase("two-issues", twoIssues)]
    const run = makeRun(cases, 1, [
      completed("two-issues", 1, twoIssues, "failure", [highFinding], [
        judgement([0], false, "known-failure"),
        judgement([0], false, "second-failure"),
      ]),
    ])
    const score = scoreRun(run).cases[0]!
    assert.equal(score.issueDetectionRate, 1 / 2)
    assert.equal(score.findingPrecision, 1)
    assert.equal(score.groundedConclusionAgreement, 0)
  })

  it("uses the valid severity pairing when finding matches overlap", () => {
    const mixedIssues: ExpectedResult = {
      issues: [
        blocking.issues[0]!,
        {
          ...blocking.issues[0]!,
          id: "smaller-failure",
          severity: "medium",
        },
      ],
    }
    const cases = [evalCase("mixed-issues", mixedIssues)]
    const run = makeRun(cases, 1, [
      completed("mixed-issues", 1, mixedIssues, "failure", [highFinding, mediumFinding], [
        judgement([0, 1], false, "known-failure"),
        judgement([0, 1], false, "smaller-failure"),
      ]),
    ])

    const score = scoreRun(run).cases[0]!
    assert.equal(score.issueDetectionRate, 1)
    assert.equal(score.severityAgreement, 1)
    assert.equal(score.severityThresholdAgreement, 1)
    assert.equal(score.groundedConclusionAgreement, 1)
  })

  it("keeps duplicate findings visible in the plain report", () => {
    const cases = [evalCase("blocking", blocking)]
    const run = makeRun(cases, 1, [
      completed("blocking", 1, blocking, "failure", [highFinding, highFinding], [
        judgement([0, 1], false),
      ]),
    ])

    const score = scoreRun(run)
    assert.equal(score.cases[0]!.findingPrecision, 1 / 2)
    assert.match(formatReport(run, score), /1 other finding needs checking/)
  })

  it("does not report failed clean reviews as clean", () => {
    const cases = [evalCase("control", control)]
    assert.equal(scoreRun(makeRun(cases, 1, [failed("control", 1, control)])).cleanAlertRate, null)
  })

  it("keeps older two-key run evidence readable", () => {
    const cases = [evalCase("control", control)]
    const fields = runFields(cases, 1)
    assert.doesNotThrow(() =>
      evalRunSchema.parse({
        ...fields,
        reviewer: {
          ...fields.reviewer,
          account: {
            separation: "verified-user-id",
            trustedIdHash: artifactHash,
            reviewerIdHash: `sha256:${"b".repeat(64)}`,
          },
        },
        samples: [completed("control", 1, control, "success", [], [])],
      }),
    )
  })

  it("rejects changed run evidence", () => {
    const cases = [evalCase("control", control)]
    assert.throws(
      () =>
        evalRunSchema.parse({
          ...runFields(cases, 1),
          corpusHash: artifactHash,
          samples: [completed("control", 1, control, "success", [], [])],
        }),
      /corpus hash does not match/,
    )
  })

  it("rejects a judgement that references a missing finding", () => {
    const cases = [evalCase("blocking", blocking)]
    assert.throws(
      () =>
        evalRunSchema.parse({
          ...runFields(cases, 1),
          samples: [
            completed("blocking", 1, blocking, "failure", [highFinding], [judgement([1], false)]),
          ],
        }),
      /finding that was not retained/,
    )
  })

  it("rejects a conclusion that does not follow from the raw review", () => {
    const cases = [evalCase("blocking", blocking)]
    assert.throws(
      () =>
        evalRunSchema.parse({
          ...runFields(cases, 1),
          samples: [completed("blocking", 1, blocking, "failure", [], [])],
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
      const issue = blocking.issues[0]!
      const first = judgeIssue(
        "blocking",
        issue,
        [highFinding],
        cacheDirectory,
        "test-sdk",
        new AbortController().signal,
        executeJudge as never,
      )
      await started.promise
      const second = judgeIssue(
        "blocking",
        issue,
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
      const issue = blocking.issues[0]!
      const first = judgeIssue(
        "blocking",
        issue,
        [highFinding],
        cacheDirectory,
        "test-sdk",
        firstController.signal,
        executeJudge as never,
      )
      await firstStarted.promise
      const second = judgeIssue(
        "blocking",
        issue,
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
      const result = judgeIssue(
        "blocking",
        blocking.issues[0]!,
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

async function createPackFixture(largeSourceTransfer = false): Promise<{
  root: string
  pack: string
  cache: string
  origin: string
  base: string
  clean: string
}> {
  const root = await mkdtemp(join(tmpdir(), "amp-reviewbot-pack-"))
  const source = join(root, "source")
  const origin = join(root, "origin.git")
  const pack = join(root, "pack")
  const exampleDirectory = join(pack, "examples", "local-example")
  await mkdir(source)
  await git(source, ["init", "--initial-branch=main"])
  await git(source, ["config", "user.name", "Eval Test"])
  await git(source, ["config", "user.email", "eval@example.invalid"])
  await writeFile(join(source, "code.txt"), "line one\n")
  await git(source, ["add", "code.txt"])
  await git(source, ["commit", "-m", "base"])
  const base = (await git(source, ["rev-parse", "HEAD"])).trim()
  await writeFile(join(source, "code.txt"), "line one\nline two\n")
  await git(source, ["commit", "-am", "clean change"])
  const clean = (await git(source, ["rev-parse", "HEAD"])).trim()
  await execFileAsync("git", ["clone", "--bare", source, origin])

  await writeFile(join(source, "code.txt"), "line one\nbug\n")
  if (largeSourceTransfer) {
    await writeFile(join(source, "large-source.bin"), randomBytes(128 * 1024))
  }
  await git(source, ["add", "--all"])
  await git(source, ["commit", "-m", "source-only bug"])
  const bug = (await git(source, ["rev-parse", "HEAD"])).trim()
  await git(source, ["branch", "eval/local-bug", bug])
  await mkdir(join(exampleDirectory, "witnesses"), { recursive: true })
  await git(source, [
    "bundle",
    "create",
    join(exampleDirectory, "commits.bundle"),
    "refs/heads/eval/local-bug",
    `^${clean}`,
  ])
  await writeFile(join(exampleDirectory, "witnesses", "bug.patch"), "test patch\n")
  await writeFile(
    join(exampleDirectory, "example.json"),
    `${JSON.stringify(
      {
        formatVersion: 1,
        id: "local-example",
        source: {
          repository: "example/repository",
          pullRequest: 42,
          baseCommit: base,
          context: {
            title: "Keep the useful result",
            body: "A local test example.",
            baseRef: "main",
            headRef: "change",
          },
        },
        versions: [
          { name: "clean-change", commit: clean, knownIssues: [] },
          {
            name: "serious-bug",
            commit: bug,
            knownIssues: [
              {
                id: "known-bug",
                severity: "high",
                rootCause: "The changed line discards the result.",
                failureBehavior: "Loses the useful result.",
                path: "code.txt",
                line: 2,
                verification: "The focused test fails only here.",
                witness: "witnesses/bug.patch",
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
  return { root, pack, cache: join(root, "cache"), origin, base, clean }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function makeRun(cases: ReturnType<typeof evalCase>[], samplesPerCase: number, samples: unknown[]) {
  return evalRunSchema.parse({ ...runFields(cases, samplesPerCase), samples })
}

function runFields(cases: ReturnType<typeof evalCase>[], samplesPerCase: number) {
  return {
    schemaVersion: 2,
    corpusVersion: "test-v1",
    corpusHash: corpusContentHash({ version: "test-v1", cases }),
    startedAt: "2026-08-25T00:00:00.000Z",
    completedAt: "2026-08-25T00:10:00.000Z",
    requestedSamplesPerCase: samplesPerCase,
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
      project: "source-project",
      account: {
        authentication: "local-cli",
      },
    },
    cases,
  }
}

function evalCase(id: string, expected: ExpectedResult) {
  return {
    id,
    seedId: id,
    versionName: id,
    repositoryFullName: "lox/example",
    pullNumber: 42,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    context: {
      title: "Example change",
      body: "Exercises the eval scorer.",
      baseRef: "main",
      headRef: "example-change",
    },
    changedLines: { "src/example.ts": [10] },
    expected: structuredClone(expected),
  }
}

function completed(
  caseId: string,
  sample: number,
  expected: ExpectedResult,
  conclusion: "success" | "neutral" | "failure",
  findings: Array<typeof lowFinding | typeof mediumFinding | typeof highFinding>,
  judgements: Array<ReturnType<typeof judgement>>,
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
    judgements,
    judgementErrors: [],
  }
}

function failed(caseId: string, sample: number, expected: ExpectedResult) {
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

function judgement(
  matchingFindingIndices: number[],
  disagreement: boolean,
  issueId = "known-failure",
) {
  return {
    issueId,
    matchingFindingIndices,
    votes: disagreement
      ? [matchingFindingIndices, []]
      : [matchingFindingIndices, matchingFindingIndices],
    disagreement,
    models: ["test-judge"],
    provenance: {
      version: "3",
      mode: "high",
      sdkVersion: "test-sdk",
      project: "no-project",
      promptHash: "prompt",
      schemaHash: "schema",
    },
  }
}

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

function accountFetch(accounts: Record<string, string>): typeof fetch {
  return async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization")
    const key = authorization?.replace(/^Bearer /, "") ?? ""
    const userId = accounts[key]
    return userId
      ? Response.json({ userId, wsToken: "unused", poolName: "unused" }, { status: 201 })
      : Response.json({ error: "unauthorized" }, { status: 401 })
  }
}
