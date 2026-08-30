import assert from "node:assert/strict"
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
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
  auditEvidenceBoundary,
  finishJudgements,
  orderedReviewTasks,
  recordFinishedRun,
  selectCases,
} from "../eval/run.js"
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
    assert.equal(example.origin, "synthetic")
    assert.equal(example.split, "development")
    assert.equal(example.versions.length, 2)
    assert.equal((await checkPack("eval")).summary.knownIssues, 1)

    const oneVersion = structuredClone(example)
    delete oneVersion.origin
    delete oneVersion.split
    oneVersion.versions.splice(1)
    assert.equal(exampleSchema.parse(oneVersion).versions.length, 1)
  })

  it("keeps maintainability advisories non-blocking", async () => {
    const input = JSON.parse(await readFile("eval/example.json", "utf8")) as {
      versions: Array<{
        knownIssues: Array<{
          severity: string
          nature?: string
          category?: string
          subtype?: string
        }>
      }>
    }
    const issue = input.versions[1]!.knownIssues[0]!
    issue.nature = "maintainability-advisory"
    issue.category = "maintainability"
    issue.subtype = "duplication"
    assert.throws(() => exampleSchema.parse(input), /maintainability advisory cannot be blocking/)
  })

  it("allows source-confirmed baseline issues when the introduced version repeats them", async () => {
    const input = JSON.parse(await readFile("eval/example.json", "utf8")) as {
      versions: Array<{ knownIssues: Array<Record<string, unknown>> }>
    }
    const introducedIssue = input.versions[1]!.knownIssues[0]!
    const baselineIssue = {
      ...introducedIssue,
      id: "inherited-defect",
      severity: "medium",
      rootCause: "The baseline change already mishandles an interrupted response.",
      failureBehavior: "An interrupted response leaves completed work unrecorded.",
      line: 80,
      verification: "Source inspection and a focused regression establish the baseline defect.",
    }
    input.versions[0]!.knownIssues.push(baselineIssue)
    input.versions[1]!.knownIssues.unshift(structuredClone(baselineIssue))

    assert.doesNotThrow(() => exampleSchema.parse(input))
    input.versions[1]!.knownIssues[0]!.line = 81
    assert.doesNotThrow(() => exampleSchema.parse(input))
    input.versions[1]!.knownIssues[0]!.failureBehavior = "A different claim."
    assert.throws(() => exampleSchema.parse(input), /without semantic changes/)
  })

  it("requires synthetic maintainability issues to identify their subtype", async () => {
    const input = JSON.parse(await readFile("eval/example.json", "utf8")) as {
      versions: Array<{
        knownIssues: Array<{
          severity: string
          nature?: string
          category?: string
          subtype?: string
        }>
      }>
    }
    const issue = input.versions[1]!.knownIssues[0]!
    issue.severity = "medium"
    issue.nature = "maintainability-advisory"
    issue.category = "maintainability"
    delete issue.subtype
    assert.throws(() => exampleSchema.parse(input), /must declare duplication or non-idiomatic Go/)
  })

  it("keeps non-idiomatic Go advisories low severity", async () => {
    const input = JSON.parse(await readFile("eval/example.json", "utf8")) as {
      versions: Array<{
        knownIssues: Array<{
          severity: string
          nature?: string
          category?: string
          subtype?: string
        }>
      }>
    }
    const issue = input.versions[1]!.knownIssues[0]!
    issue.severity = "medium"
    issue.nature = "maintainability-advisory"
    issue.category = "maintainability"
    issue.subtype = "non-idiomatic-go"
    assert.throws(() => exampleSchema.parse(input), /must use low severity/)

    const invalid = evalCase("non-idiomatic", {
      issues: [
        {
          ...blocking.issues[0]!,
          severity: "medium",
          nature: "maintainability-advisory",
          category: "maintainability",
          subtype: "non-idiomatic-go",
        },
      ],
    })
    assert.throws(() => evalCaseSchema.parse(invalid), /must use low severity/)
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
        [{ "code.txt": [2, 3] }, { "code.txt": [2, 3] }],
      )
      assert.equal(expectedConclusion(loaded.corpus.cases[1]!.expected), "failure")
      assert.deepEqual(
        loaded.corpus.cases.map((item) => item.versionRole),
        ["baseline", "introduced-issue"],
      )
      assert.equal(loaded.sourcePreparation.has("local-example/clean-change"), true)
      const baselinePreparation = loaded.sourcePreparation.get("local-example/clean-change")!
      const preparation = loaded.sourcePreparation.get("local-example/serious-bug")!
      assert.match(preparation, /source snapshot/)
      assert.match(preparation, /base64 --decode/)
      assert.doesNotMatch(
        preparation.replace(/^git remote add origin .*$/m, ""),
        /eval|reviewbot|expected answers|focused tests/i,
      )
      assert.doesNotMatch(
        baselinePreparation.replace(/^git remote add origin .*$/m, ""),
        /eval|reviewbot|expected answers|focused tests/i,
      )
      assert.match(baselinePreparation, new RegExp(`git fetch --depth=1 origin ${fixture.base}`))
      assert.match(preparation, new RegExp(`git fetch --depth=1 origin ${fixture.base}`))
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

      await writeFile(join(fixture.source, "future.txt"), "not part of the review\n")
      await git(fixture.source, ["add", "future.txt"])
      await git(fixture.source, ["commit", "-m", "future change"])
      const future = (await git(fixture.source, ["rev-parse", "HEAD"])).trim()
      await git(fixture.source, ["push", fixture.origin, `${future}:refs/heads/main`])
      const prepared = join(fixture.root, "prepared")
      await execFileAsync("git", ["clone", fixture.origin, prepared])
      await runSourcePreparation(preparation, prepared)
      assert.equal((await git(prepared, ["rev-parse", "HEAD"])).trim(), loaded.corpus.cases[1]!.headSha)
      assert.equal((await git(prepared, ["remote"])).trim(), "")
      assert.deepEqual(
        (await git(prepared, ["for-each-ref", "--format=%(refname)"])).trim().split("\n"),
        ["refs/source/base", "refs/source/target"],
      )
      assert.doesNotMatch(
        await git(prepared, ["reflog", "show", "--all", "--format=%H"]),
        new RegExp(future),
      )
      await assert.rejects(git(prepared, ["cat-file", "-e", `${future}^{commit}`]))

      await git(fixture.origin, ["tag", "public-clean", fixture.clean])
      await git(fixture.origin, ["update-ref", "refs/heads/main", fixture.base])
      const reloaded = await loadPack(fixture.pack, fixture.cache, () => fixture.origin)
      assert.match(
        reloaded.sourcePreparation.get("local-example/serious-bug")!,
        new RegExp(`refs/source/target.*${loaded.corpus.cases[1]!.headSha}`, "s"),
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

  it("requires a synthetic issue to be introduced directly on the labeled line", async () => {
    const fixture = await createPackFixture()
    const examplePath = join(fixture.pack, "examples", "local-example", "example.json")
    try {
      const input = JSON.parse(await readFile(examplePath, "utf8")) as {
        versions: Array<{
          commit: string
          knownIssues: Array<{ line: number }>
        }>
      }

      input.versions[0]!.commit = fixture.base
      await writeFile(examplePath, `${JSON.stringify(input, null, 2)}\n`)
      await assert.rejects(
        loadPack(fixture.pack, fixture.cache, () => fixture.origin),
        /must be one direct commit on top of clean-change/,
      )

      input.versions[0]!.commit = fixture.clean
      input.versions[1]!.knownIssues[0]!.line = 3
      await writeFile(examplePath, `${JSON.stringify(input, null, 2)}\n`)
      await assert.rejects(
        loadPack(fixture.pack, fixture.cache, () => fixture.origin),
        /must point to a line changed by the synthetic commit/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it("canonicalizes uppercase commit SHAs before Git comparisons", async () => {
    const fixture = await createPackFixture()
    const examplePath = join(fixture.pack, "examples", "local-example", "example.json")
    try {
      const input = JSON.parse(await readFile(examplePath, "utf8")) as {
        source: { baseCommit: string }
        versions: Array<{ commit: string }>
      }
      input.source.baseCommit = input.source.baseCommit.toUpperCase()
      for (const version of input.versions) version.commit = version.commit.toUpperCase()
      await writeFile(examplePath, `${JSON.stringify(input, null, 2)}\n`)

      const loaded = await loadPack(fixture.pack, fixture.cache, () => fixture.origin)
      for (const evalCase of loaded.corpus.cases) {
        assert.equal(evalCase.baseSha, evalCase.baseSha.toLowerCase())
        assert.equal(evalCase.headSha, evalCase.headSha.toLowerCase())
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it("reuses public bundle prerequisites when preparing a historical revision", async () => {
    const fixture = await createPackFixture()
    const examplePath = join(fixture.pack, "examples", "local-example", "example.json")
    try {
      const input = JSON.parse(await readFile(examplePath, "utf8")) as {
        origin: string
        source: { baseCommit: string }
        versions: Array<unknown>
      }
      input.origin = "human-review"
      input.source.baseCommit = fixture.alternate
      input.versions.splice(0, 1)
      await writeFile(examplePath, `${JSON.stringify(input, null, 2)}\n`)

      const loaded = await loadPack(fixture.pack, fixture.cache, () => fixture.origin)
      const preparation = loaded.sourcePreparation.get("local-example/serious-bug")!
      const encodedBundle = /printf '%s' '([^']+)' \| base64 --decode/.exec(preparation)?.[1]
      assert.ok(encodedBundle)
      const header = Buffer.from(encodedBundle, "base64").subarray(0, 1_024).toString("utf8")
      assert.match(header, new RegExp(`-${fixture.base} `))
      assert.match(preparation, new RegExp(`git fetch --depth=2 origin ${fixture.alternate}`))

      const prepared = join(fixture.root, "prepared-historical")
      await mkdir(prepared)
      await runSourcePreparation(preparation, prepared)
      assert.equal((await git(prepared, ["rev-parse", "HEAD"])).trim(), loaded.corpus.cases[0]!.headSha)
      assert.equal(
        (await git(prepared, ["merge-base", fixture.alternate, loaded.corpus.cases[0]!.headSha])).trim(),
        fixture.base,
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

  it("returns the complete reviewer trace and model evidence", async () => {
    const spawned = deferred<void>()
    const childInput = deferred<{ cwd: string; [key: string]: unknown }>()
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    stdin.on("data", (chunk: Buffer) => {
      childInput.resolve(JSON.parse(chunk.toString("utf8")))
    })
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams
    const trace = [
      {
        type: "assistant",
        session_id: "thread-1",
        message: { model: "test-model", content: [] },
      },
    ]
    const review = runBlindReview(
      {
        prompt: "Review this change.",
        title: "Test review",
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      },
      () => {
        spawned.resolve()
        return child
      },
    )
    await spawned.promise
    const submitted = await childInput.promise
    assert.equal("project" in submitted, false)
    await stat(submitted.cwd)
    await assert.rejects(stat(join(submitted.cwd, ".git")))
    stdout.write(
      JSON.stringify({
        status: "completed",
        rawResult: '{"summary":"Done","findings":[]}',
        threadId: "thread-1",
        models: ["test-model"],
        trace,
      }),
    )
    child.emit("close", 0, null)

    assert.deepEqual(await review, {
      status: "completed",
      rawResult: '{"summary":"Done","findings":[]}',
      threadId: "thread-1",
      models: ["test-model"],
      trace,
    })
    await assert.rejects(stat(submitted.cwd))
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

  it("keeps holdouts out of development runs", () => {
    const legacy = evalCase("legacy", control)
    const development = { ...evalCase("development", control), split: "development" as const }
    const holdout = { ...evalCase("holdout", control), split: "holdout" as const }

    assert.deepEqual(
      selectCases([legacy, development, holdout], "development").map((item) => item.id),
      ["legacy", "development"],
    )
    assert.deepEqual(
      selectCases([legacy, development, holdout], "holdout").map((item) => item.id),
      ["holdout"],
    )
  })

  it("randomizes each complete sample block reproducibly", () => {
    const cases = [evalCase("one", control), evalCase("two", control), evalCase("three", control)]
    const first = orderedReviewTasks(cases, 3, "fixed-seed")
    const second = orderedReviewTasks(cases, 3, "fixed-seed")

    assert.deepEqual(
      first.map(({ evalCase: item, sample }) => [item.id, sample]),
      second.map(({ evalCase: item, sample }) => [item.id, sample]),
    )
    for (const sample of [1, 2, 3]) {
      const block = first.filter((task) => task.sample === sample)
      assert.deepEqual(
        new Set(block.map((task) => task.evalCase.id)),
        new Set(cases.map((item) => item.id)),
      )
    }
  })

  it("flags external evidence while allowing the exact source setup", () => {
    const target = "a".repeat(40)
    const sourceCommand = `set -euo pipefail
git remote add origin 'https://github.com/example/repository.git'
git fetch origin ${"a".repeat(40)}
test "$(git rev-parse refs/source/target)" = '${target}'
test "$(git rev-parse HEAD)" = '${target}'
git for-each-ref --format='delete %(refname)' | git update-ref --stdin`
    const sourcePreparation = `Prepare the exact source snapshot before review.

Run these commands from the repository:

${sourceCommand}

Use only this checked-out source snapshot.`
    const trace = [
      traceSystemMessage(),
      toolMessage(
        "shell_command",
        {
          command: sourceCommand,
          workdir: "/workspace",
        },
        "source-preparation",
      ),
      toolResultMessage("source-preparation"),
      toolMessage("web_search", { objective: "Find later fixes" }),
      toolMessage("shell_command", { command: "gh pr view 42 --comments" }),
    ]

    assert.deepEqual(auditEvidenceBoundary(trace, sourcePreparation), [
      "used external-source tool web_search",
      "ran an external network command",
    ])
    assert.deepEqual(
      auditEvidenceBoundary(
        [
          traceSystemMessage(),
          toolMessage(
            "shell_command",
            {
              command: sourceCommand.replaceAll("\n", " && "),
            },
            "altered-preparation",
          ),
          toolResultMessage("altered-preparation"),
        ],
        sourcePreparation,
      ),
      ["did not complete the trusted source preparation"],
    )
    assert.deepEqual(
      auditEvidenceBoundary(
        [
          traceSystemMessage(),
          toolMessage("shell_command", { command: sourceCommand }, "source-preparation"),
          toolMessage("shell_command", { command: "git status" }, "early-inspection"),
          toolResultMessage("source-preparation"),
          toolResultMessage("early-inspection"),
        ],
        sourcePreparation,
      ),
      ["did not complete the trusted source preparation"],
    )
    assert.deepEqual(
      auditEvidenceBoundary(
        [
          toolMessage("shell_command", {
            command: `git -c protocol.version=2 fetch origin ${"b".repeat(40)}`,
          }),
        ],
        undefined,
      ),
      ["ran an unapproved Git network command"],
    )
    assert.deepEqual(
      auditEvidenceBoundary(
        [toolMessage("shell_command", { command: "git show HEAD@{1}:src/review.ts" })],
        undefined,
      ),
      ["inspected source outside the exact review history"],
    )
    assert.deepEqual(auditEvidenceBoundary([], sourcePreparation), [
      "did not start in an isolated review workspace",
      "did not complete the trusted source preparation",
    ])
    assert.deepEqual(
      auditEvidenceBoundary(
        [
          traceSystemMessage(),
          toolMessage("shell_command", { command: sourceCommand }, "failed-preparation"),
          toolResultMessage("failed-preparation", true),
          toolMessage("shell_command", { command: sourceCommand }, "successful-retry"),
          toolResultMessage("successful-retry"),
        ],
        sourcePreparation,
      ),
      ["did not complete the trusted source preparation"],
    )
    assert.deepEqual(
      auditEvidenceBoundary(
        [
          traceSystemMessage(),
          ...sourceCommand.split("\n").flatMap((command, index) => [
            toolMessage("shell_command", { command }, `split-${index}`),
            toolResultMessage(`split-${index}`),
          ]),
        ],
        sourcePreparation,
      ),
      ["did not complete the trusted source preparation"],
    )
    assert.deepEqual(
      auditEvidenceBoundary(
        [
          traceSystemMessage(),
          toolMessage(
            "shell_command",
            { command: sourceCommand.replace(/^test .*\n/m, "") },
            "missing-attestation",
          ),
          toolResultMessage("missing-attestation"),
        ],
        sourcePreparation,
      ),
      ["did not complete the trusted source preparation"],
    )
    assert.deepEqual(
      auditEvidenceBoundary(
        [
          traceSystemMessage(),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/tmp/other" },
            "wrong-workdir",
          ),
          toolResultMessage("wrong-workdir"),
        ],
        sourcePreparation,
      ),
      ["did not complete the trusted source preparation"],
    )
    assert.deepEqual(
      auditEvidenceBoundary(
        [
          traceSystemMessage(),
          toolMessage("web_search", { objective: "Inspect the source" }, "early-web"),
          toolMessage("shell_command", { command: sourceCommand }, "source-preparation"),
          toolResultMessage("source-preparation"),
        ],
        sourcePreparation,
      ),
      [
        "used external-source tool web_search",
        "did not complete the trusted source preparation",
      ],
    )
    assert.deepEqual(
      auditEvidenceBoundary(
        [...trace.slice(0, 3), traceSystemMessage("thread-2")],
        sourcePreparation,
      ),
      ["review continuation changed the isolated workspace"],
    )
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
    assert.equal(blockingScore.frozenLabelMatchFraction, 2 / 3)
    assert.equal(blockingScore.severityAgreement, 1 / 2)
    assert.equal(blockingScore.severityThresholdAgreement, 1 / 2)
    assert.equal(blockingScore.judgeCoverage, 1)
    assert.equal(blockingScore.judgeDisagreementRate, 1 / 3)

    const report = formatReport(run, score)
    assert.match(report, /Review evaluation: INCOMPLETE/)
    assert.match(report, /no frozen issues: 1 of 2 completed reviews raised no clean alert/)
    assert.match(report, /blocking labels: found in 2 of 3; frozen-label response matched in 1 of 3/)
    assert.match(report, /This result covers only these examples/)

    const contaminatedRun = structuredClone(run)
    contaminatedRun.samples[2]!.evidenceBoundaryViolations = [
      "did not complete the trusted source preparation",
    ]
    const contaminatedReport = formatReport(contaminatedRun, scoreRun(contaminatedRun))
    assert.match(contaminatedReport, /Review evaluation: CONTAMINATED/)
    assert.match(
      contaminatedReport,
      /this run must not be used as review-quality evidence/,
    )

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
    assert.match(
      completeReport,
      /blocking labels: found in 3 of 3; frozen-label response matched in 0 of 3/,
    )
  })

  it("does not let one finding count as two known issues", () => {
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
    assert.equal(score.frozenLabelMatchFraction, 1)
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
    assert.equal(score.cases[0]!.frozenLabelMatchFraction, 1 / 2)
    assert.match(formatReport(run, score), /1 unmatched finding needs source checking/)
  })

  it("does not report failed clean reviews as clean", () => {
    const cases = [evalCase("control", control)]
    assert.equal(scoreRun(makeRun(cases, 1, [failed("control", 1, control)])).cleanAlertRate, null)
  })

  it("scores a synthetic seed only when both paired versions match", () => {
    const baseline = {
      ...evalCase("paired-baseline", control),
      seedId: "paired",
      origin: "synthetic" as const,
      versionRole: "baseline" as const,
      headSha: "b".repeat(40),
    }
    const introduced = {
      ...evalCase("paired-introduced", blocking),
      seedId: "paired",
      origin: "synthetic" as const,
      versionRole: "introduced-issue" as const,
      headSha: "c".repeat(40),
    }
    const run = makeRun([baseline, introduced], 3, [
      completed(baseline.id, 1, control, "success", [], []),
      completed(introduced.id, 1, blocking, "failure", [highFinding], [judgement([0], false)]),
      completed(baseline.id, 2, control, "success", [], []),
      completed(introduced.id, 2, blocking, "failure", [highFinding], [judgement([0], false)]),
      completed(baseline.id, 3, control, "neutral", [lowFinding], []),
      completed(introduced.id, 3, blocking, "failure", [highFinding], [judgement([0], false)]),
    ])

    assert.deepEqual(scoreRun(run).seeds[0], {
      seedId: "paired",
      pullNumber: 42,
      origin: "synthetic",
      samples: 3,
      passedSamples: 2,
      outcome: "unstable",
    })
  })

  it("requires complete prompts and traces in new run artifacts", () => {
    const cases = [evalCase("blocking", blocking)]
    const oldRun = makeRun(cases, 1, [
      completed("blocking", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
    ])
    const prompt = "complete review prompt"
    const trace = [{ type: "result", result: "review result" }]
    const sample = {
      ...oldRun.samples[0]!,
      prompt,
      promptHash: createHash("sha256").update(prompt).digest("hex"),
      trace,
      reviewDurationMs: 10,
      matchingDurationMs: 0,
      durationMs: 10,
      evidenceBoundaryViolations: [],
    }
    const run = {
      ...oldRun,
      schemaVersion: 3,
      judgeTimeoutMs: 60_000,
      reviewsCompletedAt: oldRun.completedAt,
      orderSeed: "fixed-seed",
      executionOrder: [{ caseId: "blocking", sample: 1 }],
      samples: [sample],
    }
    assert.doesNotThrow(() => evalRunSchema.parse(run))
    run.samples[0]!.promptHash = "0".repeat(64)
    assert.throws(() => evalRunSchema.parse(run), /prompt hash does not match/)
    run.samples[0]!.promptHash = createHash("sha256").update(prompt).digest("hex")
    run.samples[0]!.durationMs = 11
    assert.throws(() => evalRunSchema.parse(run), /sample duration must equal/)
    run.samples[0]!.durationMs = 10
    const mutableSample = run.samples[0] as { trace: unknown[] }
    mutableSample.trace = [
      toolMessage("web_search", { objective: "Find later fixes" }),
    ]
    assert.throws(() => evalRunSchema.parse(run), /saved evidence audit does not match/)
    mutableSample.trace = trace
    if (run.samples[0]!.status !== "completed") assert.fail("expected completed sample")
    run.samples[0]!.judgements[0]!.provenance.promptHash = "0".repeat(64)
    assert.throws(() => evalRunSchema.parse(run), /judgement prompt hash does not match/)
    run.samples[0]!.judgements[0]!.provenance.promptHash = createHash("sha256")
      .update(run.samples[0]!.judgements[0]!.provenance.prompt!)
      .digest("hex")
    delete (run.samples[0] as { prompt?: string }).prompt
    assert.throws(() => evalRunSchema.parse(run), /full prompt, trace, phase timings/)
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

  it("checks finding matches without requiring a source project", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "amp-reviewbot-eval-"))
    const options: Array<Record<string, unknown>> = []
    const executeJudge = async function* (input: { options: Record<string, unknown> }) {
      options.push(input.options)
      yield judgeResult()
    }

    try {
      const result = await judgeIssue(
        "blocking",
        blocking.issues[0]!,
        [highFinding],
        cacheDirectory,
        "test-sdk",
        new AbortController().signal,
        executeJudge as never,
      )
      assert.equal(options.length, 2)
      assert.ok(options.every((item) => !("project" in item)))
      assert.ok(options.every((item) => item.cwd === tmpdir()))
      assert.equal(result.provenance.project, null)
      assert.match(result.provenance.prompt!, /Known issue:/)
      assert.match(result.provenance.responseSchema!, /matchingFindingIndices/)
      assert.equal(
        result.provenance.promptHash,
        createHash("sha256").update(result.provenance.prompt!).digest("hex"),
      )
      assert.equal(
        result.provenance.schemaHash,
        createHash("sha256").update(result.provenance.responseSchema!).digest("hex"),
      )
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true })
    }
  })

  it("finishes missing comparisons without changing saved reviews", async () => {
    const sample = completed("blocking", 1, blocking, "failure", [highFinding], [])
    const sourceRun = makeRun([evalCase("blocking", blocking)], 1, [
      {
        ...sample,
        judgementErrors: [{ issueId: "known-failure", error: "comparison failed" }],
      },
    ])
    const sourceBytes = Buffer.from(`${JSON.stringify(sourceRun, null, 2)}\n`)
    let calls = 0
    const judge = (async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return judgement([0], false)
    }) as typeof judgeIssue

    const { run, attempted } = await finishJudgements(
      sourceRun,
      { judgeCache: "/unused", concurrency: 1, timeoutMs: 1_000 },
      "test-sdk",
      judge,
    )
    assert.equal(attempted, 1)
    assert.equal(calls, 1)
    assert.equal(run.samples[0]!.status, "completed")
    if (run.samples[0]!.status !== "completed") assert.fail("expected completed sample")
    if (sourceRun.samples[0]!.status !== "completed") assert.fail("expected completed source")
    assert.equal(run.samples[0]!.rawResult, sourceRun.samples[0]!.rawResult)
    assert.equal(run.samples[0]!.durationMs, sourceRun.samples[0]!.durationMs)
    assert.equal(run.samples[0]!.matchingDurationMs, undefined)
    assert.deepEqual(run.samples[0]!.judgementErrors, [])
    assert.equal(run.samples[0]!.judgements.length, 1)

    const noOp = await finishJudgements(
      run,
      { judgeCache: "/unused", concurrency: 1, timeoutMs: 1_000 },
      "test-sdk",
      judge,
    )
    assert.equal(noOp.attempted, 0)
    assert.equal(calls, 1)

    const finishedAt = "2026-08-29T10:00:00.000Z"
    const recorded = recordFinishedRun(run, sourceBytes, finishedAt)
    assert.equal(recorded.completedAt, sourceRun.completedAt)
    assert.deepEqual(recorded.finishedFrom, {
      sourceArtifactHash: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`,
      finishedAt,
    })
    assert.equal(sourceRun.finishedFrom, undefined)
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
  source: string
  pack: string
  cache: string
  origin: string
  base: string
  clean: string
  alternate: string
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
  await writeFile(join(source, "code.txt"), "line one\nline two\nline three\n")
  await git(source, ["commit", "-am", "clean change"])
  const clean = (await git(source, ["rev-parse", "HEAD"])).trim()
  await execFileAsync("git", ["clone", "--bare", source, origin])

  await git(source, ["switch", "--create", "alternate", base])
  await writeFile(join(source, "alternate.txt"), "alternate base\n")
  await git(source, ["add", "alternate.txt"])
  await git(source, ["commit", "-m", "alternate public base"])
  const alternate = (await git(source, ["rev-parse", "HEAD"])).trim()
  await git(source, ["push", origin, `${alternate}:refs/heads/alternate`])
  await git(source, ["switch", "main"])

  await writeFile(join(source, "code.txt"), "line one\nbug\nline three\n")
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
        origin: "synthetic",
        split: "development",
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
                nature: "behavioral-defect",
                category: "functional-correctness",
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
  return { root, source, pack, cache: join(root, "cache"), origin, base, clean, alternate }
}

async function runSourcePreparation(preparation: string, cwd: string): Promise<void> {
  const commands = /Run these commands from the repository:\n\n([\s\S]+?)\n\nUse only/.exec(
    preparation,
  )?.[1]
  assert.ok(commands)
  await execFileAsync("bash", ["-c", commands], { cwd })
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
  const prompt = "saved matching prompt"
  const responseSchema = '{"matchingFindingIndices":[0]}'
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
      prompt,
      responseSchema,
      promptHash: createHash("sha256").update(prompt).digest("hex"),
      schemaHash: createHash("sha256").update(responseSchema).digest("hex"),
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

function traceSystemMessage(sessionId = "thread-1", cwd = "/workspace") {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    tools: [],
    mcp_servers: [],
  }
}

function toolMessage(name: string, input: Record<string, unknown>, id = "tool") {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name, input }],
    },
  }
}

function toolResultMessage(toolUseId: string, isError = false) {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: "command completed",
          is_error: isError,
        },
      ],
    },
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
