import assert from "node:assert/strict"
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PassThrough } from "node:stream"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { AmpOptionsSchema, type StreamMessage } from "@ampcode/sdk"
import { checkReviewTrace, modelsFromTrace } from "../eval/evidence.js"
import { formatAbDecision, interleavedAbTasks, loadFrozenSet } from "../eval/ab.js"
import { judgeIssue, resolveMatchingVotes } from "../eval/judge.js"
import { checkPack, exampleSchema, loadPack } from "../eval/pack.js"
import { chanceSentence, formatComparison } from "../eval/compare.js"
import { formatReport, reviewResources } from "../eval/report.js"
import { formatRescoreSummary, rescoreRun } from "../eval/rescore.js"
import { ampExitError, evaluationAmpArgs, keepThreadTrace } from "../eval/reviewer-child.js"
import {
  reviewAuthentication,
  reviewerEnvironment,
  runEvaluationReview,
  execFailureReason,
  parseThreadUsage,
  usageUnavailableReason,
} from "../eval/reviewer.js"
import {
  finishJudgements,
  loadPromptVariant,
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
  type EvalCase,
  type ExpectedResult,
} from "../eval/schema.js"
import { scoreRun } from "../eval/score.js"
import {
  judgeMode,
  pinnedModel,
  reviewMode,
} from "../src/amp.js"
import { buildSourceSetupPrompt, preparedSourceVerificationCommand } from "../src/review.js"
import { isTransientAmpError } from "../src/worker.js"

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
const testAmpVersions = { sdkVersion: "test-sdk", cliVersion: "test-cli" }
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

  it("rejects repository names that are not safe GitHub owner/repository names", async () => {
    const input = JSON.parse(await readFile("eval/example.json", "utf8")) as {
      source: { repository: string }
    }
    for (const repository of [
      "owner/repository/extra",
      "owner with spaces/repository",
      "owner/repository'; touch escaped",
    ]) {
      input.source.repository = repository
      assert.throws(() => exampleSchema.parse(input), /GitHub owner\/repository name/)
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
      assert.match(preparation, /exact source/)
      assert.match(preparation, /base64 --decode/)
      assert.match(preparation, /Do not inspect pull request #42/)
      assert.match(preparation, /Public documentation, package registries, dependencies/)
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

  it("shell-quotes custom source URLs in the preparation block", async () => {
    const fixture = await createPackFixture()
    const quotedOrigin = join(fixture.root, "origin'quoted.git")
    try {
      await rename(fixture.origin, quotedOrigin)
      const loaded = await loadPack(fixture.pack, fixture.cache, () => quotedOrigin)
      const preparation = loaded.sourcePreparation.get("local-example/serious-bug")!
      assert.match(preparation, /git remote add origin '.*'"'"'.*'/)

      const prepared = join(fixture.root, "prepared-quoted-origin")
      await mkdir(prepared)
      await runSourcePreparation(preparation, prepared)
      assert.equal(
        (await git(prepared, ["rev-parse", "HEAD"])).trim(),
        loaded.corpus.cases[1]!.headSha,
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

  it("keeps missing model IDs explicit in historical samples", () => {
    const sample = completed("control", 1, control, "success", [], [])
    sample.models = []
    assert.deepEqual(evalSampleSchema.parse(sample).models, [])
  })

  it("records model IDs only when Amp reports them", () => {
    const messageWithoutModel = {
      type: "assistant",
      message: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Review complete." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, service_tier: "standard" },
      },
      parent_tool_use_id: null,
      session_id: "thread-1",
    }
    const messageWithModel = {
      ...messageWithoutModel,
      message: { ...messageWithoutModel.message, model: "openai/test-model" },
    }

    assert.deepEqual(modelsFromTrace([messageWithoutModel]), [])
    assert.deepEqual(modelsFromTrace([messageWithModel, messageWithModel]), ["openai/test-model"])
  })

  it("pins the review agents without replacing their built-in modes", async () => {
    const agentConfigs: Array<Record<string, unknown>> = []
    const modes: Array<Record<string, unknown>> = []
    const pluginPath = pathToFileURL(resolve("plugins", "pinned-models.js")).href
    const plugin: { default: (amp: Record<string, unknown>) => void } = await import(pluginPath)
    plugin.default({
      createAgent(config: Record<string, unknown>) {
        agentConfigs.push(config)
        return { definition: config }
      },
      registerAgentMode(mode: Record<string, unknown>) {
        modes.push(mode)
      },
      on() {},
    })

    assert.deepEqual(
      agentConfigs.map(({ extends: extendedMode, model, reasoningEffort, oracle }) => ({
        extendedMode,
        model,
        reasoningEffort,
        oracle,
      })),
      [
        {
          extendedMode: "medium",
          model: pinnedModel,
          reasoningEffort: "medium",
          oracle: { model: pinnedModel, reasoningEffort: "high" },
        },
        {
          extendedMode: "high",
          model: pinnedModel,
          reasoningEffort: "xhigh",
          oracle: { model: pinnedModel, reasoningEffort: "high" },
        },
      ],
    )
    assert.deepEqual(
      modes.map(({ key }) => key),
      [reviewMode, judgeMode],
    )
  })

  it("prepares evaluation source in the plugin before the reviewer starts", async () => {
    let startHandler:
      | ((
          event: { message: string },
          context: Record<string, unknown>,
        ) => Promise<unknown>)
      | undefined
    const pluginPath = pathToFileURL(resolve("plugins", "pinned-models.js")).href
    const plugin: { default: (amp: Record<string, unknown>) => void } = await import(pluginPath)
    plugin.default({
      createAgent(config: Record<string, unknown>) {
        return { definition: config }
      },
      registerAgentMode() {},
      on(event: string, handler: typeof startHandler) {
        if (event === "agent.start") startHandler = handler
      },
      system: { workspaceRoot: { path: "/workspace" } },
      helpers: {
        filePathFromURI(uri: { path: string }) {
          return uri.path
        },
      },
    })
    assert.ok(startHandler)

    const calls: Array<{ strings: string[]; values: unknown[] }> = []
    let cancellations = 0
    const result = await startHandler(
      {
        message:
          "<reviewbot-source-setup-v1>\nprintf 'ready'\n</reviewbot-source-setup-v1>\n\nReview now.",
      },
      {
        $: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          calls.push({ strings: [...strings], values })
          return { exitCode: 0, stdout: "", stderr: "" }
        },
        thread: {
          async cancel() {
            cancellations += 1
          },
        },
      },
    )

    assert.deepEqual(calls, [
      {
        strings: ["cd ", " && bash -c ", ""],
        values: ["/workspace", "printf 'ready'"],
      },
    ])
    assert.equal(cancellations, 0)
    assert.deepEqual(result, {
      message: { content: "The trusted source setup completed successfully. Do not repeat it." },
    })

    await startHandler(
      { message: "<reviewbot-source-setup-v2>\nprintf bad\n</reviewbot-source-setup-v2>" },
      {
        $: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        thread: {
          async cancel() {
            cancellations += 1
          },
        },
      },
    )
    assert.equal(cancellations, 1)

    await startHandler(
      { message: "<reviewbot-source-setup-v1>\nexit 1\n</reviewbot-source-setup-v1>" },
      {
        $: async () => ({ exitCode: 1, stdout: "", stderr: "setup failed" }),
        thread: {
          async cancel() {
            cancellations += 1
          },
        },
      },
    )
    assert.equal(cancellations, 2)

    const ordinary = await startHandler(
      { message: "Review this pull request." },
      {
        $: async () => assert.fail("ordinary reviews must not run source setup"),
        thread: { cancel: async () => assert.fail("ordinary reviews must not be cancelled") },
      },
    )
    assert.equal(ordinary, undefined)
  })

  it("waits for plugin hooks when starting an evaluation orb", () => {
    const args = evaluationAmpArgs(
      AmpOptionsSchema.parse({
        cwd: "/tmp/empty-source",
        executor: "orb",
        mode: reviewMode,
        noArchiveAfterExecute: true,
        visibility: "private",
        labels: ["reviewbot"],
        title: "Review example/repository#42",
      }),
    )

    assert.deepEqual(args, [
      "--execute",
      "--stream-json",
      "--orb-execute",
      "--plugin-ready-timeout",
      "30",
      "--mode",
      reviewMode,
      "--no-archive-after-execute",
      "--visibility",
      "private",
      "--label",
      "reviewbot",
      "--title",
      "Review example/repository#42",
    ])
  })

  it("runs the review again when the Amp CLI dies before streaming anything", () => {
    const startup = ampExitError(1, "error: dlopen(/$bunfs/root/keyring.node): no such file\n", false)
    assert.equal(isTransientAmpError(startup), true)
    assert.equal(
      startup.message,
      "Amp CLI exited with status 1 before starting the review: error: dlopen(/$bunfs/root/keyring.node): no such file",
    )

    const midway = ampExitError(1, "", true)
    assert.equal(isTransientAmpError(midway), false)
    assert.equal(midway.message, "Amp CLI exited with status 1")
  })

  it("keeps only the fresh thread's trace after a restart", () => {
    const trace = [
      traceSystemMessage("thread-1", "/workspace", reviewMode),
      toolMessage("shell_command", { command: "git status" }, "abandoned"),
      traceSystemMessage("thread-2", "/workspace", reviewMode),
    ].map((message, index) => ({
      ...message,
      session_id: index < 2 ? "thread-1" : "thread-2",
    })) as unknown as StreamMessage[]

    keepThreadTrace(trace, "thread-2")

    assert.equal(trace.length, 1)
    assert.equal(trace[0]?.session_id, "thread-2")
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
    const review = runEvaluationReview(
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
    await assert.rejects(review, /Could not send evaluation review input/)
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
    const review = runEvaluationReview(
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
    assert.equal(submitted.prompt, "Review this change.")
    await stat(submitted.cwd)
    await assert.rejects(stat(join(submitted.cwd, ".git")))
    await assert.rejects(stat(join(submitted.cwd, ".amp")))
    stdout.write(
      JSON.stringify({
        status: "completed",
        rawResult: '{"summary":"Done","findings":[]}',
        threadId: "thread-1",
        models: ["test-model"],
        trace,
        retries: 1,
      }),
    )
    child.emit("close", 0, null)

    assert.deepEqual(await review, {
      status: "completed",
      rawResult: '{"summary":"Done","findings":[]}',
      threadId: "thread-1",
      models: ["test-model"],
      trace,
      retries: 1,
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

  it("can run only the versions that drive the blocking numbers", () => {
    const cases: EvalCase[] = [
      evalCase("control", control),
      evalCase("advisory", { issues: [{ ...blocking.issues[0]!, severity: "medium" }] }),
      evalCase("blocking", blocking),
    ]
    assert.deepEqual(
      selectCases(cases, "development", ["blocking", "control"]).map((item) => item.id),
      ["control", "blocking"],
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

  it("interleaves A/B pairs with reproducible order", () => {
    const cases = [evalCase("one", control), evalCase("two", control), evalCase("three", control)]
    const tasks = interleavedAbTasks(cases, "fixed-seed")
    assert.deepEqual(tasks, interleavedAbTasks(cases, "fixed-seed"))
    for (let index = 0; index < tasks.length; index += 2) {
      assert.equal(tasks[index]!.evalCase.id, tasks[index + 1]!.evalCase.id)
      assert.deepEqual(new Set([tasks[index]!.variant, tasks[index + 1]!.variant]), new Set(["A", "B"]))
    }
  })

  it("loads the frozen set before and after an advisory is adjudicated as blocking", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reviewbot-frozen-set-"))
    const advisory: ExpectedResult = {
      issues: [{ ...blocking.issues[0]!, severity: "medium" }],
    }
    const cases: EvalCase[] = [
      ...Array.from({ length: 10 }, (_, index) => evalCase(`blocking-${index}/version`, blocking)),
      ...Array.from({ length: 3 }, (_, index) => evalCase(`clean-${index}/version`, control)),
      ...Array.from({ length: 3 }, (_, index) => evalCase(`advisory-${index}/version`, advisory)),
    ]
    try {
      await mkdir(join(directory, "sets"))
      await writeFile(
        join(directory, "sets", "fast-v1.json"),
        JSON.stringify({
          formatVersion: 1,
          name: "fast-v1",
          cases: cases.map((evalCase) => {
            const [example, version] = evalCase.id.split("/")
            return { example, version }
          }),
        }),
      )

      const frozen = await loadFrozenSet(directory, "fast-v1", cases)
      assert.deepEqual(frozen.cases.map((evalCase) => evalCase.id), cases.map((evalCase) => evalCase.id))
      assert.match(frozen.identifier, /^fast-v1@[0-9a-f]{12}$/)

      cases[13]!.expected = blocking
      await assert.doesNotReject(loadFrozenSet(directory, "fast-v1", cases))

      cases[0]!.split = "holdout"
      await assert.rejects(loadFrozenSet(directory, "fast-v1", cases), /must not contain holdout/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("builds safe built-in prompt variants without loading code from refs", async () => {
    const job = {
      id: "eval-prompt-1",
      sourceDeliveryId: "eval-prompt-1",
      eventType: "eval.replay",
      installationId: "0",
      repositoryId: "0",
      repositoryFullName: "example/repository",
      pullNumber: 42,
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      ampProject: "no-project",
      pullRequestContext: null,
      checkRunId: null,
      ampThreadId: null,
      status: "running",
      attempts: 1,
    } as const
    const [beforeGuide, current] = await Promise.all([
      loadPromptVariant("pre-severity-guide"),
      loadPromptVariant("current"),
    ])

    assert.doesNotMatch(beforeGuide.build(job), /Severity is about what happens/)
    assert.match(current.build(job), /Severity is about what happens/)
    assert.match(current.identifier, /^current@[0-9a-f]{12}$/)
  })

  it("allows public research but flags access to the target source", () => {
    const headSha = "a".repeat(40)
    const target = {
      repository: "example/repository",
      pullNumber: 42,
      baseSha: "b".repeat(40),
      headSha,
    }
    const sourceCommand = `set -euo pipefail
git remote add origin 'https://github.com/example/repository.git'
git fetch origin ${headSha}
test "$(git rev-parse refs/source/target)" = '${headSha}'
test "$(git rev-parse HEAD)" = '${headSha}'
git for-each-ref --format='delete %(refname)' | git update-ref --stdin`
    const sourcePreparation = `Prepare the exact source before review.

Run these commands from the repository:

${sourceCommand}

Use only this checked-out source.`
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
      toolMessage("web_search", { objective: "Read the dependency API documentation" }),
      toolMessage("shell_command", { command: "npm view example-package version" }),
      toolMessage("web_search", { objective: "Inspect example/repository PR 42" }),
      toolMessage("shell_command", { command: "gh pr view 42 --comments" }),
      toolMessage("shell_command", { command: "git fetch origin" }),
    ]

    assert.deepEqual(checkReviewTrace(trace, sourcePreparation, target), [
      "accessed the target pull request",
      "accessed the target repository outside the supplied copy",
    ])
    assert.deepEqual(
      checkReviewTrace(
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
      ["did not complete the required source setup"],
    )
    const verificationCommand = preparedSourceVerificationCommand(target)
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage("thread-1", "/workspace", reviewMode),
          toolMessage(
            "shell_command",
            { command: verificationCommand, workdir: "/home/user/workspace" },
            "source-verification",
          ),
          toolResultMessage("source-verification", false, 0),
          toolMessage(
            "shell_command",
            { command: "git status", workdir: "/home/user/workspace" },
            "inspection",
          ),
          toolResultMessage("inspection"),
        ],
        sourcePreparation,
        target,
        reviewMode,
        "plugin",
      ),
      [],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage("thread-1", "/workspace", reviewMode),
          toolMessage(
            "shell_command",
            { command: verificationCommand, workdir: "/home/user/workspace" },
            "failed-verification",
          ),
          toolResultMessage("failed-verification", false, 1),
        ],
        sourcePreparation,
        target,
        reviewMode,
        "plugin",
      ),
      ["did not complete the required source setup"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage("thread-1", "/workspace", reviewMode),
          toolMessage(
            "shell_command",
            { command: verificationCommand, workdir: "/home/user/workspace" },
            "verification-without-exit-code",
          ),
          toolResultMessage("verification-without-exit-code"),
        ],
        sourcePreparation,
        target,
        reviewMode,
        "plugin",
      ),
      ["did not complete the required source setup"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage("thread-1", "/workspace", reviewMode),
          toolMessage(
            "shell_command",
            { command: verificationCommand, workdir: "/home/user/workspace" },
            "source-verification",
          ),
          toolResultMessage("source-verification", false, 0),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/home/user/workspace" },
            "repeated-source-setup",
          ),
          toolResultMessage("repeated-source-setup"),
        ],
        sourcePreparation,
        target,
        reviewMode,
        "plugin",
      ),
      ["accessed the target repository outside the supplied copy"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage("thread-1", "/private/var/tmp/amp-reviewbot-reviewer/source"),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/home/user/workspace" },
            "orb-source-preparation",
          ),
          toolResultMessage("orb-source-preparation"),
        ],
        sourcePreparation,
      ),
      [],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/home/user/workspace" },
            "separate-setup",
          ),
          toolResultMessage("separate-setup", false, 0),
          turnResultMessage(),
          toolMessage("shell_command", {
            command: "git status",
            workdir: "/home/user/workspace",
          }),
        ],
        sourcePreparation,
        undefined,
        undefined,
        "separate-turn",
      ),
      [],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/home/user/workspace" },
            "separate-setup",
          ),
          toolResultMessage("separate-setup", false, 0),
          toolMessage(
            "shell_command",
            { command: "git status", workdir: "/home/user/workspace" },
            "extra-setup-tool",
          ),
          toolResultMessage("extra-setup-tool"),
          turnResultMessage(),
        ],
        sourcePreparation,
        undefined,
        undefined,
        "separate-turn",
      ),
      ["did not complete the required source setup"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage("shell_command", { command: sourceCommand }, "source-preparation"),
          toolResultMessage("source-preparation"),
        ],
        sourcePreparation,
      ),
      ["did not complete the required source setup"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/home/user/workspace" },
            "source-preparation",
          ),
          toolResultMessage("source-preparation"),
          toolMessage(
            "shell_command",
            { command: "git status", workdir: "/home/user/workspace/src" },
            "subdirectory-inspection",
          ),
          toolResultMessage("subdirectory-inspection"),
        ],
        sourcePreparation,
      ),
      [],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage("thread-1", "/private/var/tmp/amp-reviewbot-reviewer/source"),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/home/user/workspace" },
            "wrong-mode-preparation",
          ),
          toolResultMessage("wrong-mode-preparation"),
        ],
        sourcePreparation,
        undefined,
        "high",
      ),
      ["did not use the required agent mode"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage("shell_command", { command: sourceCommand }, "source-preparation"),
          toolMessage("shell_command", { command: "git status" }, "early-inspection"),
          toolResultMessage("source-preparation"),
          toolResultMessage("early-inspection"),
        ],
        sourcePreparation,
      ),
      ["did not complete the required source setup"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          toolMessage("shell_command", {
            command: `git -c protocol.version=2 fetch origin ${"b".repeat(40)}`,
          }),
        ],
        undefined,
        target,
      ),
      ["accessed the target repository outside the supplied copy"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [toolMessage("shell_command", { command: "git show HEAD@{1}:src/review.ts" })],
        undefined,
        target,
      ),
      [],
    )
    assert.deepEqual(checkReviewTrace([], sourcePreparation), [])
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage("shell_command", { command: sourceCommand }, "nested-failed-preparation"),
          toolResultMessage("nested-failed-preparation", false, 1),
        ],
        sourcePreparation,
      ),
      ["did not complete the required source setup"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage("shell_command", { command: sourceCommand }, "failed-preparation"),
          toolResultMessage("failed-preparation", true),
          toolMessage("shell_command", { command: sourceCommand }, "successful-retry"),
          toolResultMessage("successful-retry"),
        ],
        sourcePreparation,
      ),
      ["did not complete the required source setup"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/tmp/other" },
            "alternate-workdir",
          ),
          toolResultMessage("alternate-workdir"),
        ],
        sourcePreparation,
      ),
      [],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/home/user/workspace" },
            "source-preparation",
          ),
          toolResultMessage("source-preparation"),
          toolMessage(
            "shell_command",
            { command: "git status", workdir: "/tmp/other" },
            "wrong-workdir",
          ),
          toolResultMessage("wrong-workdir"),
        ],
        sourcePreparation,
      ),
      ["review continued in a different workspace"],
    )
    // A throwaway experiment elsewhere that never touches Git is research.
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage(
            "shell_command",
            { command: sourceCommand, workdir: "/home/user/workspace" },
            "source-preparation",
          ),
          toolResultMessage("source-preparation"),
          toolMessage(
            "shell_command",
            {
              command:
                "mkdir -p pkg cov && cat >go.mod <<'EOF'\nmodule probe\nEOF\ngo test -cover -test.gocoverdir=/tmp/probe/cov ./pkg",
              workdir: "/tmp/probe",
            },
            "scratch-workdir",
          ),
          toolResultMessage("scratch-workdir"),
        ],
        sourcePreparation,
      ),
      [],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage("web_search", { objective: "Read dependency documentation" }, "early-web"),
          toolMessage("shell_command", { command: sourceCommand }, "source-preparation"),
          toolResultMessage("source-preparation"),
        ],
        sourcePreparation,
      ),
      ["did not complete the required source setup"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [...trace.slice(0, 3), traceSystemMessage("thread-2")],
        sourcePreparation,
      ),
      ["review continued in a different workspace"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [toolMessage("functions.Task", { prompt: "Inspect example/repository PR 42" })],
        undefined,
        target,
      ),
      ["accessed the target pull request"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [toolMessage("shell_command", { command: "npm view example-package version" })],
        undefined,
        target,
      ),
      [],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          toolMessage("shell_command", {
            command: "curl https://github.com/example/repository/pull/42",
          }),
        ],
        undefined,
        target,
      ),
      ["accessed the target pull request"],
    )
    assert.deepEqual(
      checkReviewTrace(
        [
          toolMessage("shell_command", {
            command: "gh pr view 42 -R dependency/library",
          }),
          toolMessage("web_search", {
            objective: "Inspect dependency/library PR 42",
          }),
        ],
        undefined,
        target,
      ),
      [],
    )
  })

  it("does not flag research that explicitly avoids the target or scratch git repositories", () => {
    const target = {
      repository: "example/repository",
      pullNumber: 42,
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
    }
    const compliantQueries = [
      "In the public example/repository-stack-k8s repository, how are command containers launched?",
      "Read https://raw.githubusercontent.com/example/repository-stack-k8s/main/cmd/flags.go",
      "In dependency/library v1.2, inspect Parse. Do not inspect example/repository or PR #42.",
      "Inspect github.com/dependency/library at v0.1.1. Do not inspect github.com/example/repository.",
      "In example/server (server, not example/repository), inspect the API. Do not inspect example/repository or GitHub PR #42.",
      "Compare tags v1.0.0 and v1.0.1 of dependency/library relevant to downstream github.com/example/repository/v3. Do not inspect example/repository or PR #42.",
      "Research for a local PR review; do not inspect example/repository or its PR.\nCite exact files.",
    ]
    for (const query of compliantQueries) {
      assert.deepEqual(
        checkReviewTrace([toolMessage("librarian", { query })], undefined, target),
        [],
        query,
      )
    }
    for (const query of [
      "Inspect example/repository, not the dependency.",
      "Clone https://github.com/example/repository.git and read the checkout code.",
    ]) {
      assert.deepEqual(
        checkReviewTrace([toolMessage("librarian", { query })], undefined, target),
        ["accessed the target repository outside the supplied copy"],
        query,
      )
    }
    assert.deepEqual(
      checkReviewTrace(
        [
          toolMessage("librarian", {
            query: "Read PR #42 in example/repository. Do not inspect other repositories.",
          }),
        ],
        undefined,
        target,
      ),
      ["accessed the target pull request"],
    )
    const scratchCommands = [
      'rg -n "GitFetchFlags|git fetch" internal/job/*_test.go | head -200',
      "rg -n 'git-fetch-flags|GIT_FETCH_FLAGS' . | head",
      'tmp=$(mktemp -d)\ngit init -q "$tmp/work"\ngit -C "$tmp/work" fetch --filter=blob:none origin "$sha"',
      "git --git-dir=/tmp/scratch/.git fetch origin main",
      "git --version && git fetch -h | sed -n '/--filter/,+3p' && git clone -h | head",
      "git help --no-man-viewer fetch 2>&1 | sed -n '/--filter/,/--refetch/p'",
      "git -c core.pager=cat help fetch",
    ]
    for (const command of scratchCommands) {
      assert.deepEqual(
        checkReviewTrace(
          [
            traceSystemMessage(),
            toolMessage("shell_command", { command: "git status", workdir: "/workspace" }, "first"),
            toolResultMessage("first"),
            toolMessage("shell_command", { command, workdir: "/workspace" }, "scratch"),
            toolResultMessage("scratch"),
          ],
          undefined,
          target,
        ),
        [],
        command,
      )
    }
    const preparedCommands = [
      'git fetch origin "refs/pull/42/head"',
      "git -C . fetch origin main",
      "git -C /workspace fetch origin main",
      'git -C "/workspace/agent" fetch origin main',
      "git --git-dir=/workspace/.git fetch origin main",
      "git --work-tree /workspace pull",
    ]
    for (const command of preparedCommands) {
      assert.deepEqual(
        checkReviewTrace(
          [
            traceSystemMessage(),
            toolMessage("shell_command", { command: "git status", workdir: "/workspace" }, "first"),
            toolResultMessage("first"),
            toolMessage("shell_command", { command, workdir: "/workspace" }, "update"),
            toolResultMessage("update"),
          ],
          undefined,
          target,
        ),
        ["accessed the target repository outside the supplied copy"],
        command,
      )
    }
    assert.deepEqual(
      checkReviewTrace(
        [
          traceSystemMessage(),
          toolMessage("shell_command", { command: "git status", workdir: "/workspace" }, "first"),
          toolResultMessage("first"),
          toolMessage(
            "shell_command",
            { command: "git -C ../../workspace fetch origin main", workdir: "/tmp/scratch" },
            "update",
          ),
          toolResultMessage("update"),
        ],
        undefined,
        target,
      ),
      [
        "review continued in a different workspace",
        "accessed the target repository outside the supplied copy",
      ],
    )
  })

  it("requires a separate review account before creating an artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amp-reviewbot-eval-auth-"))
    const output = join(directory, "run.json")
    try {
      await assert.rejects(
        execFileAsync(
          process.execPath,
          ["--import", "tsx", "eval/run.ts", "run", "missing-pack", "--output", output],
          {
            cwd: resolve("."),
            env: {
              ...process.env,
              AMP_API_KEY: "",
              AMP_EVAL_REVIEWER_API_KEY: "",
            },
          },
        ),
        /Set AMP_EVAL_REVIEWER_API_KEY to a separate account/,
      )
      assert.equal(await stat(output).catch(() => null), null)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("eval scoring", () => {
  it("prints the predeclared fast A/B decision from binary conclusions", () => {
    const advisory: ExpectedResult = {
      issues: [{ ...blocking.issues[0]!, severity: "medium" }],
    }
    const cases = [
      ...Array.from({ length: 10 }, (_, index) => evalCase(`blocking-${index}`, blocking)),
      ...Array.from({ length: 3 }, (_, index) => evalCase(`clean-${index}`, control)),
      ...Array.from({ length: 3 }, (_, index) => evalCase(`advisory-${index}`, advisory)),
    ]
    const run = (blocked: number) =>
      makeRun(
        cases,
        1,
        cases.map((evalCase, index) =>
          completed(
            evalCase.id,
            1,
            evalCase.expected,
            index < blocked ? "failure" : "success",
            index < blocked ? [highFinding] : [],
            [],
          ),
        ),
      )
    const decision = formatAbDecision({
      setIdentifier: "fast-v1@abc",
      promptA: "old@aaa",
      promptB: "new@bbb",
      runA: run(5),
      runB: run(8),
      wallTimeMs: 65_000,
    })

    assert.match(decision, /Blocking versions blocked: +A 5\/10 +B 8\/10/)
    assert.match(decision, /Non-blocking versions blocked: A 0\/6 +B 0\/6/)
    assert.match(decision, /Recommendation: PROMISING B/)
    assert.match(decision, /Wall time: 1m 5s/)

    const incompleteB = makeRun(
      cases,
      1,
      cases.map((evalCase, index) =>
        index < 3
          ? failed(evalCase.id, 1, evalCase.expected)
          : completed(evalCase.id, 1, evalCase.expected, "success", [], []),
      ),
    )
    const incomplete = formatAbDecision({
      setIdentifier: "fast-v1@abc",
      promptA: "old@aaa",
      promptB: "new@bbb",
      runA: run(5),
      runB: incompleteB,
      wallTimeMs: 65_000,
    })
    assert.match(incomplete, /Execution failures: 3/)
    assert.match(incomplete, /Recommendation: KEEP A/)
    assert.doesNotMatch(incomplete, /Recommendation: REGRESSION/)
  })

  it("scores each review by whether it made the right call", () => {
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

    assert.equal(score.completedReviews, 5)
    assert.equal(controlScore.completed, 2)
    assert.equal(controlScore.quiet, 1)
    assert.equal(controlScore.wronglyBlocked, 0)
    assert.equal(controlScore.rightCalls, 2)
    assert.equal(blockingScore.blockedForRecordedBug, 1)
    assert.equal(blockingScore.blockedForOtherReason, 1)
    assert.equal(blockingScore.foundAtLowerUrgency, 1)
    assert.equal(blockingScore.missed, 0)
    assert.equal(blockingScore.rightCalls, 1)
    assert.equal(blockingScore.unmatchedFindings, 1)
    assert.deepEqual(score.scorecard.badPrs, {
      versions: 1,
      reviews: 3,
      blocked: 1,
      blockedForOtherReason: 1,
      foundAtLowerUrgency: 1,
      missed: 0,
      versionsRightEveryTime: 0,
    })
    assert.deepEqual(score.scorecard.cleanPrs, { versions: 1, reviews: 2, quiet: 1 })
    // The control never blocked, but one of its three repeats did not finish.
    assert.deepEqual(score.scorecard.okPrs, {
      versions: 1,
      reviews: 2,
      wronglyBlocked: 0,
      versionsRightEveryTime: 0,
    })

    const report = formatReport(run)
    assert.match(report, /Recorded result: INCOMPLETE/)
    assert.match(report, /2 code versions from 2 pull requests, each reviewed 3 times; 5 of 6 reviews completed/)
    assert.match(report, /Bad PRs blocked: +1 of 3 \(33%\) across 1 version with a recorded blocking bug; 0 blocked every time\. Of the rest: 1 blocked for something else, 1 found the bug at lower urgency, 0 missed it\./)
    assert.match(report, /OK PRs wrongly blocked: 0 of 2 \(0%\) across 1 version without one; 0 never blocked\./)
    assert.match(report, /Clean PRs left alone: +1 of 2 \(50%\) across 1 version with no recorded issues\./)
    assert.match(report, /Recorded advisory issues found: none to count\./)
    assert.match(report, /no recorded issues: left alone in 1 of 2; raised a non-blocking finding in 1/)
    assert.match(report, /recorded blocking bug: blocked for it in 1 of 3; blocked for something else in 1; found it at lower urgency in 1; 1 unmatched finding needs source checking/)
    assert.doesNotMatch(report, /Wrongly blocked \(check the source/)
    assert.match(report, /This result covers only these examples/)

    const contaminatedRun = structuredClone(run)
    contaminatedRun.samples[3]!.evidenceBoundaryViolations = [
      "did not complete the required source setup",
    ]
    const contaminatedReport = formatReport(contaminatedRun)
    assert.match(contaminatedReport, /Recorded result: INCOMPLETE/)
    assert.match(contaminatedReport, /4 of 6 reviews completed/)
    assert.match(contaminatedReport, /recorded blocking bug: blocked for it in 0 of 2; blocked for something else in 1; found it at lower urgency in 1/)
    assert.match(
      contaminatedReport,
      /1 review did not follow the review rules and is excluded from these counts/,
    )

    const completeRun = makeRun(cases, 3, [
      completed("control", 1, control, "success", [], []),
      completed("control", 2, control, "success", [], []),
      completed("control", 3, control, "failure", [highFinding], []),
      completed("blocking", 1, blocking, "neutral", [mediumFinding], [judgement([0], false)]),
      completed("blocking", 2, blocking, "neutral", [mediumFinding], [judgement([0], false)]),
      completed("blocking", 3, blocking, "neutral", [mediumFinding], [judgement([0], false)]),
    ])
    const completeReport = formatReport(completeRun)
    assert.match(completeReport, /Recorded result: NEEDS WORK/)
    assert.match(completeReport, /2 pull-request examples: 0 pass, 1 unstable, 1 fail/)
    assert.match(completeReport, /Wrongly blocked \(check the source; a justified block means the recorded issues are incomplete\):\n  #42 version: blocked in 1 of 3/)
    assert.match(completeReport, /no recorded issues: left alone in 2 of 3; wrongly blocked in 1/)
    assert.match(completeReport, /recorded blocking bug: blocked for it in 0 of 3; found it at lower urgency in 3/)

    assert.throws(
      () =>
        evalRunSchema.parse({
          ...completeRun,
          reviewer: {
            ...completeRun.reviewer,
            protocol: "research-enabled-target-frozen",
            project: null,
            account: {
              authentication: "reviewer-api-key",
              reviewerIdHash: artifactHash,
            },
          },
        }),
      /evaluation requires schema version 3 evidence/,
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
    assert.equal(score.blockedForRecordedBug, 1)
    assert.equal(score.unmatchedFindings, 0)
    assert.equal(score.advisoryChances, 0)
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
    assert.equal(score.blockedForRecordedBug, 1)
    assert.equal(score.advisoryFound, 1)
    assert.equal(score.unmatchedFindings, 0)
  })

  it("keeps duplicate findings visible in the plain report", () => {
    const cases = [evalCase("blocking", blocking)]
    const run = makeRun(cases, 1, [
      completed("blocking", 1, blocking, "failure", [highFinding, highFinding], [
        judgement([0, 1], false),
      ]),
    ])

    const score = scoreRun(run)
    assert.equal(score.cases[0]!.unmatchedFindings, 1)
    assert.match(formatReport(run), /1 unmatched finding needs source checking/)
  })

  it("reports review time and reviewer tokens from the saved traces", () => {
    const cases = [evalCase("blocking", blocking)]
    const usage = (input: number, cached: number, output: number) => ({
      type: "assistant",
      message: { usage: { input_tokens: input, cache_read_input_tokens: cached, output_tokens: output } },
    })
    const run = makeRun(cases, 3, [
      {
        ...completed("blocking", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
        reviewDurationMs: 60_000,
        trace: [{ type: "system" }, usage(1_000, 0, 100), usage(500, 2_000, 400)],
      },
      {
        ...completed("blocking", 2, blocking, "failure", [highFinding], [judgement([0], false)]),
        reviewDurationMs: 180_000,
        trace: [usage(300_000, 0, 500)],
        retries: 2,
      },
      { ...failed("blocking", 3, blocking), reviewDurationMs: 300_000, trace: [], retries: 0 },
    ])

    assert.deepEqual(reviewResources(run), {
      reviews: 3,
      totalReviewMs: 540_000,
      medianReviewMs: 180_000,
      longestReviewMs: 300_000,
      retried: { reviews: 1, runs: 2 },
      traced: { reviews: 2, inputTokens: 303_500, outputTokens: 1_000, medianInputTokens: 151_750 },
    })
    const report = formatReport(run)
    assert.match(report, /Review time: 3 reviews took 9\.0 min in total; median 3\.0 min, longest 5\.0 min\./)
    assert.match(report, /Amp had to be run again in 1 review \(2 extra runs\); the time above includes those runs\./)
    assert.match(report, /Reviewer tokens from 2 traces: 304k input tokens .*, 1k output tokens; median 152k input tokens per review\./)
    assert.match(report, /recorded no Amp usage, so cost is unknown/)

    const withoutTimings = makeRun(cases, 1, [
      completed("blocking", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
    ])
    assert.equal(reviewResources(withoutTimings), undefined)
    assert.doesNotMatch(formatReport(withoutTimings), /Review time/)

    const withoutRetries = makeRun(cases, 1, [
      { ...failed("blocking", 1, blocking), reviewDurationMs: 300_000, trace: [] },
    ])
    assert.deepEqual(reviewResources(withoutRetries)!.retried, { reviews: 0, runs: 0 })
    assert.doesNotMatch(formatReport(withoutRetries), /run again/)
  })

  it("says why Amp reported no usage instead of implying the lookup never ran", () => {
    const cases = [evalCase("blocking", blocking)]
    const unavailable = "Usage information is currently unavailable for this thread."
    const trace = [{ type: "assistant", message: { usage: { input_tokens: 1_000, output_tokens: 10 } } }]
    const run = makeRun(cases, 3, [
      {
        ...completed("blocking", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
        reviewDurationMs: 60_000,
        trace,
        usageUnavailable: unavailable,
      },
      {
        ...completed("blocking", 2, blocking, "failure", [highFinding], [judgement([0], false)]),
        reviewDurationMs: 60_000,
        trace,
        usageUnavailable: unavailable,
      },
      {
        ...failed("blocking", 3, blocking),
        reviewDurationMs: 60_000,
        trace,
        usageUnavailable: "amp threads usage failed: Command failed",
      },
    ])

    assert.deepEqual(reviewResources(run)!.usageUnavailable, {
      reviews: 3,
      reasons: ["Usage information is currently unavailable for this thread.", "amp threads usage failed: Command failed"],
    })
    assert.match(
      formatReport(run),
      /Amp reported no usage for 3 review threads \(Usage information is currently unavailable for this thread\.; amp threads usage failed: Command failed\), so cost is unknown/,
    )
    assert.doesNotMatch(formatReport(run), /recorded no Amp usage/)
  })

  it("prefers the usage Amp billed over tokens summed from the trace", () => {
    const cases = [evalCase("blocking", blocking)]
    const usage = (costUsd: number, subscriptionUsed = false) => ({
      costUsd,
      inputTokens: 1_000_000,
      outputTokens: 5_000,
      requests: 10,
      subscriptionUsed,
    })
    const run = makeRun(cases, 3, [
      {
        ...completed("blocking", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
        reviewDurationMs: 60_000,
        trace: [{ type: "assistant", message: { usage: { input_tokens: 5, output_tokens: 1 } } }],
        usage: usage(1.25),
      },
      {
        ...completed("blocking", 2, blocking, "failure", [highFinding], [judgement([0], false)]),
        reviewDurationMs: 60_000,
        usage: usage(0.75, true),
      },
      { ...failed("blocking", 3, blocking), reviewDurationMs: 60_000, trace: [] },
    ])

    assert.deepEqual(reviewResources(run)!.billed, {
      reviews: 2,
      costUsd: 2,
      medianCostUsd: 1,
      inputTokens: 2_000_000,
      outputTokens: 10_000,
      requests: 20,
      subscriptionUsed: true,
    })
    const report = formatReport(run)
    assert.match(
      report,
      /Amp usage \(2 of 3 reviews reported usage\): \$2\.00 in credits, 2\.0M input tokens, 10k output tokens, 20 model requests; median \$1\.00 per review\. Subagent threads are included\. A subscription covered some inference/,
    )
    assert.doesNotMatch(report, /Reviewer tokens from/)
  })

  it("reads cost and tokens from the amp threads usage report", () => {
    const report = [
      "# Thread Usage",
      "",
      "## Review buildkite/agent#3238",
      "",
      "Scope: Entire lifetime of this thread, including 2 subagent threads.",
      "",
      "Cost: $1,234.56",
      "Total tokens: 37,184,694",
      "Input tokens: 37,008,927 (35,168,961 cache reads)",
      "Output tokens: 175,767",
      "Requests: 366",
      "Orb runtime: 2h31m16.141s (9,076,141 ms)",
      "Your ChatGPT subscription was used for some inference.",
      "",
      "## Credits",
      "",
      "| Type | Cost |",
      "| --- | ---: |",
      "| Personal paid credits | $21.57 |",
    ].join("\n")
    assert.deepEqual(parseThreadUsage(report), {
      costUsd: 1234.56,
      inputTokens: 37_008_927,
      outputTokens: 175_767,
      requests: 366,
      subscriptionUsed: true,
    })
    const covered = parseThreadUsage(report.replace("Cost: $1,234.56", "Cost: $0"))!
    assert.equal(covered.costUsd, 0)
    assert.equal(covered.subscriptionUsed, true)
    assert.equal(parseThreadUsage("# Thread Usage\n\nSomething else entirely\n"), null)

    const withheld = [
      "Review buildkite/agent#3907",
      "Usage information is currently unavailable for this thread.",
      "Details: https://ampcode.com/threads/T-1/usage",
      "",
      "## Orb System Metrics",
    ].join("\n")
    assert.equal(parseThreadUsage(withheld), null)
    assert.equal(usageUnavailableReason(withheld), "Usage information is currently unavailable for this thread.")
    assert.equal(usageUnavailableReason("# Thread Usage\n"), "amp threads usage printed no cost or token counts")

    const failed = Object.assign(new Error("Command failed: node_modules/.bin/amp threads usage --details T-1"), {
      code: 1,
      stderr: "\nError: Thread not found\n",
    })
    assert.equal(execFailureReason(failed), "Error: Thread not found")
    assert.equal(execFailureReason(Object.assign(new Error("Command failed"), { killed: true, stderr: "" })), "timed out")
    assert.equal(execFailureReason(Object.assign(new Error("Command failed"), { code: 2, stderr: "" })), "exited with 2")
    assert.equal(execFailureReason("boom"), "unknown error")
  })

  it("reports dropped raw findings and counts missed chances, not reviews", () => {
    const unchangedLineFinding = { ...highFinding, startLine: 386 }
    const twoIssues: ExpectedResult = {
      issues: [
        blocking.issues[0]!,
        { ...blocking.issues[0]!, id: "second-failure" },
      ],
    }
    const cases = [evalCase("blocking", twoIssues)]
    const rawResult = { summary: "Review complete", findings: [highFinding, unchangedLineFinding] }
    const sample = {
      ...completed("blocking", 1, twoIssues, "failure", [highFinding], [
        judgement([0], false),
        judgement([], false, "second-failure"),
      ]),
      rawResult: JSON.stringify(rawResult),
      parsedResult: rawResult,
      omitted: 1,
    }
    const run = makeRun(cases, 1, [sample])

    const report = formatReport(run)
    assert.match(
      report,
      /recorded blocking bug: blocked for it in 1 of 1; 1 raw finding dropped for not pointing at a changed line/,
    )
    assert.equal(scoreRun(run).cases[0]!.droppedFindings, 1)
  })

  it("compares two runs version by version", () => {
    const cases = [
      evalCase("control", control),
      evalCase("blocking", blocking),
      { ...evalCase("extra", control), headSha: "e".repeat(40) },
    ]
    const a = makeRun(cases, 2, [
      completed("control", 1, control, "success", [], []),
      completed("control", 2, control, "failure", [highFinding], []),
      completed("blocking", 1, blocking, "neutral", [mediumFinding], [judgement([0], false)]),
      completed("blocking", 2, blocking, "neutral", [mediumFinding], [judgement([0], false)]),
      completed("extra", 1, control, "success", [], []),
      completed("extra", 2, control, "success", [], []),
    ])
    const b = makeRun(cases.slice(0, 2), 2, [
      completed("control", 1, control, "success", [], []),
      completed("control", 2, control, "success", [], []),
      completed("blocking", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
      completed("blocking", 2, blocking, "neutral", [mediumFinding], [judgement([0], false)]),
    ])

    const comparison = formatComparison({ name: "a.json", run: a }, { name: "b.json", run: b })
    assert.match(comparison, /Compared on 2 shared code versions\. Left out: 1 version in only one run\./)
    assert.doesNotMatch(comparison, /Incomplete:/)
    assert.match(comparison, /older rules/)
    // The extra control in A is left out of A's scorecard, not just the per-version lists.
    assert.match(comparison, /A:\n  Bad PRs blocked:.*\n  OK PRs wrongly blocked: 1 of 2 \(50%\) across 1 version without one/)
    assert.match(comparison, /Bad PRs blocked:\n  A 0 of 2 \(0%\), B 1 of 2 \(50%\)\.\n  B better on 1 version, A better on 0, same on 0\. Only 1 version differs: too few to tell from chance\.\n  B better:\n    #42 version: A 0 of 2 → B 1 of 2/)
    assert.match(comparison, /OK PRs wrongly blocked:\n  A 1 of 2 \(50%\), B 0 of 2 \(0%\)\.\n  B better on 1 version/)
    assert.match(comparison, /Right call on every version and repeat: A 0, B 1 of 2 versions\./)
  })

  it("leaves out a version whose commits or recorded issues changed between runs, and discloses missing reviews", () => {
    const cases = [evalCase("control", control), evalCase("blocking", blocking)]
    const a = makeRun(cases, 2, [
      completed("control", 1, control, "success", [], []),
      completed("control", 2, control, "success", [], []),
      completed("blocking", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
      completed("blocking", 2, blocking, "failure", [highFinding], [judgement([0], false)]),
    ])
    const relabelled = evalCase("blocking", {
      issues: [{ ...blocking.issues[0]!, severity: "medium" }],
    })
    const b = makeRun([cases[0]!, relabelled], 2, [
      completed("control", 1, control, "success", [], []),
      failed("control", 2, control),
      completed("blocking", 1, relabelled.expected, "neutral", [mediumFinding], [judgement([0], false)]),
      completed("blocking", 2, relabelled.expected, "neutral", [mediumFinding], [judgement([0], false)]),
    ])

    const comparison = formatComparison({ name: "a.json", run: a }, { name: "b.json", run: b })
    assert.match(
      comparison,
      /Compared on 1 shared code version\. Left out: 1 version with different commits or recorded issues in the two runs \(the runs used different example packs\)\./,
    )
    assert.match(comparison, /Incomplete: B: 1 of 2 reviews count \(1 did not finish\)\. Missing reviews can tilt every number below/)
    assert.match(comparison, /Bad PRs blocked:\n  no versions to compare/)
    assert.match(comparison, /Clean PRs left alone:\n  A 2 of 2 \(100%\), B 1 of 1 \(100%\)\./)

    const moved = makeRun([cases[0]!, { ...cases[1]!, headSha: "c".repeat(40) }], 2, a.samples)
    assert.match(
      formatComparison({ name: "a.json", run: a }, { name: "moved.json", run: moved }),
      /Compared on 1 shared code version\. Left out: 1 version with different commits/,
    )
    const rewordedIssues: ExpectedResult = { issues: [{ ...blocking.issues[0]!, verification: "Reworded." }] }
    const reworded = makeRun([cases[0]!, evalCase("blocking", rewordedIssues)], 2, [
      ...a.samples.slice(0, 2),
      completed("blocking", 1, rewordedIssues, "failure", [highFinding], [judgement([0], false)]),
      completed("blocking", 2, rewordedIssues, "failure", [highFinding], [judgement([0], false)]),
    ])
    assert.match(
      formatComparison({ name: "a.json", run: a }, { name: "reworded.json", run: reworded }),
      /Compared on 1 shared code version\. Left out: 1 version with different commits or recorded issues/,
    )
    // A renamed example gets a new case ID from the pack loader but is the same version.
    const renamed = makeRun(
      [cases[0]!, { ...cases[1]!, id: "renamed/bug", seedId: "renamed", versionName: "bug" }],
      2,
      a.samples.map((sample) => (sample.caseId === "blocking" ? { ...sample, caseId: "renamed/bug" } : sample)),
    )
    const renamedComparison = formatComparison({ name: "a.json", run: a }, { name: "renamed.json", run: renamed })
    assert.match(renamedComparison, /Compared on 2 shared code versions\.\n/)
    assert.match(renamedComparison, /Bad PRs blocked:\n  A 2 of 2 \(100%\), B 2 of 2 \(100%\)\./)

    const once = makeRun(cases, 1, a.samples.filter((sample) => sample.sample === 1))
    assert.throws(
      () => formatComparison({ name: "a.json", run: a }, { name: "once.json", run: once }),
      /cannot compare runs with different repeat counts: A reviewed each version 2 times, B 1/,
    )

    // Two versions with identical content cannot be paired one-to-one with another run.
    const twin = { ...evalCase("twin", blocking), seedId: "twin-seed" }
    const twins = makeRun([...cases, twin], 2, [
      ...a.samples,
      completed("twin", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
      completed("twin", 2, blocking, "failure", [highFinding], [judgement([0], false)]),
    ])
    assert.throws(
      () => formatComparison({ name: "a.json", run: a }, { name: "twins.json", run: twins }),
      /twins\.json has two versions with identical commits, context, and recorded issues \(blocking and twin\)/,
    )

    // A different judge setup is called out, since matching decides the blocking numbers.
    const otherJudge = structuredClone(a)
    for (const sample of otherJudge.samples) {
      if (sample.status !== "completed") continue
      for (const item of sample.judgements) item.provenance.version = "4"
    }
    assert.match(
      formatComparison({ name: "a.json", run: a }, { name: "judge.json", run: otherJudge }),
      /different judge setups \(A: 3 high\/unpinned schema [0-9a-f]{7} sdk test-sdk cli test-cli; B: 4 high\/unpinned schema [0-9a-f]{7} sdk test-sdk cli test-cli\), so part of any difference may come from the matching/,
    )
    assert.doesNotMatch(comparison, /different judge setups/)
  })

  it("counts a blocking bug as found at lower urgency even when its finding also matches an advisory", () => {
    const advisoryFirst: ExpectedResult = {
      issues: [{ ...blocking.issues[0]!, id: "advisory-first", severity: "medium" }, blocking.issues[0]!],
    }
    const run = makeRun([evalCase("blocking", advisoryFirst)], 1, [
      completed("blocking", 1, advisoryFirst, "neutral", [mediumFinding], [
        judgement([0], false, "advisory-first"),
        judgement([0], false),
      ]),
    ])
    const score = scoreRun(run).cases[0]!
    assert.equal(score.foundAtLowerUrgency, 1)
    assert.equal(score.missed, 0)
  })

  it("gives a shared finding to the blocking bug regardless of issue order", () => {
    const advisory = { ...blocking.issues[0]!, id: "advisory", severity: "medium" as const }
    const orders: ExpectedResult[] = [
      { issues: [advisory, blocking.issues[0]!] },
      { issues: [blocking.issues[0]!, advisory] },
    ]
    const scores = orders.map((expected) => {
      const run = makeRun([evalCase("blocking", expected)], 1, [
        completed("blocking", 1, expected, "neutral", [mediumFinding], [
          judgement([0], false, "advisory"),
          judgement([0], false),
        ]),
      ])
      return scoreRun(run).cases[0]!
    })
    assert.deepEqual(
      scores.map((score) => [score.advisoryFound, score.foundAtLowerUrgency, score.unmatchedFindings]),
      [
        [0, 1, 0],
        [0, 1, 0],
      ],
    )
  })

  it("counts a version as right every time only when every requested repeat completed", () => {
    const cases = [evalCase("blocking", blocking)]
    const run = makeRun(cases, 2, [
      completed("blocking", 1, blocking, "failure", [highFinding], [judgement([0], false)]),
      failed("blocking", 2, blocking),
    ])
    const score = scoreRun(run)
    assert.equal(score.cases[0]!.samples, 2)
    assert.equal(score.scorecard.badPrs.versionsRightEveryTime, 0)
    assert.match(
      formatComparison({ name: "a.json", run }, { name: "b.json", run }),
      /Right call on every version and repeat: A 0, B 0 of 1 versions\./,
    )

    assert.equal(chanceSentence(0, 0), "No difference to weigh.")
    assert.match(chanceSentence(4, 1), /Only 5 versions differ: too few to tell from chance\./)
    assert.match(chanceSentence(4, 2), /about 69% of the time, so this could easily be noise/)
    assert.match(chanceSentence(9, 1), /about 2% of the time, so this looks like a real difference/)
    assert.match(chanceSentence(12, 0), /under 1% of the time, so this looks like a real difference/)
  })

  it("does not report failed clean reviews as clean", () => {
    const cases = [evalCase("control", control)]
    const score = scoreRun(makeRun(cases, 1, [failed("control", 1, control)]))
    assert.deepEqual(score.scorecard.cleanPrs, { versions: 1, reviews: 0, quiet: 0 })
    assert.match(formatReport(makeRun(cases, 1, [failed("control", 1, control)])), /no recorded issues: no reviews completed/)
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
      completed(baseline.id, 3, control, "failure", [highFinding], []),
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
    assert.throws(
      () =>
        evalRunSchema.parse({
          ...run,
          reviewer: {
            ...run.reviewer,
            protocol: "research-enabled-target-frozen",
            account: {
              authentication: "reviewer-api-key",
              reviewerIdHash: artifactHash,
            },
          },
        }),
      /evaluation requires a reviewer with no Amp project/,
    )
    const researchRun = evalRunSchema.parse({
      ...run,
      reviewer: {
        ...run.reviewer,
        cliVersion: "test-cli",
        project: null,
        protocol: "research-enabled-target-frozen-v2",
        account: {
          authentication: "reviewer-api-key",
          reviewerIdHash: artifactHash,
        },
      },
    })
    const researchReport = formatReport(researchRun)
    assert.match(researchReport, /Review evaluation: PUBLIC RESEARCH ALLOWED/)
    assert.match(researchReport, /could research anything public/)
    assert.match(
      researchReport,
      /Reviewer: Amp mode medium\. Model: not pinned\. SDK: test\. CLI: test-cli\./,
    )
    assert.match(researchReport, /Reported model IDs: test-judge, test-reviewer\./)
    assert.doesNotMatch(researchReport, /OLDER RULES/)
    const olderReport = formatReport(evalRunSchema.parse(run))
    assert.match(olderReport, /Review evaluation: OLDER RULES/)
    assert.match(olderReport, /Use its counts for investigation, not comparison\./)
    const unreportedModelsRun = structuredClone(researchRun)
    unreportedModelsRun.samples[0]!.models = []
    if (unreportedModelsRun.samples[0]!.status !== "completed") {
      assert.fail("expected completed sample")
    }
    unreportedModelsRun.samples[0]!.judgements[0]!.models = []
    assert.match(
      formatReport(unreportedModelsRun),
      /Exact model IDs: not reported by Amp\./,
    )
    const previousProtocolRun = structuredClone(researchRun)
    previousProtocolRun.reviewer.protocol = "research-enabled-target-frozen"
    delete previousProtocolRun.reviewer.cliVersion
    assert.doesNotThrow(() => evalRunSchema.parse(previousProtocolRun))
    const currentProtocolRun = structuredClone(previousProtocolRun)
    currentProtocolRun.reviewer.protocol = "research-enabled-target-frozen-v2"
    assert.throws(
      () => evalRunSchema.parse(currentProtocolRun),
      /requires the exact Amp CLI version/,
    )
    const pinnedRun = structuredClone(researchRun)
    pinnedRun.reviewer.protocol = "research-enabled-target-frozen-v3"
    pinnedRun.reviewer.mode = reviewMode
    pinnedRun.reviewer.model = pinnedModel
    if (pinnedRun.samples[0]!.status !== "completed") assert.fail("expected completed sample")
    pinnedRun.samples[0]!.judgements[0]!.provenance.mode = judgeMode
    pinnedRun.samples[0]!.judgements[0]!.provenance.model = pinnedModel
    assert.doesNotThrow(() => evalRunSchema.parse(pinnedRun))
    const splitPromptRun = structuredClone(pinnedRun)
    splitPromptRun.reviewer.protocol = "research-enabled-target-frozen-v4"
    splitPromptRun.samples[0]!.sourceSetupPrompt = "complete source setup prompt"
    splitPromptRun.samples[0]!.sourceSetupPromptHash = createHash("sha256")
      .update(splitPromptRun.samples[0]!.sourceSetupPrompt)
      .digest("hex")
    assert.doesNotThrow(() => evalRunSchema.parse(splitPromptRun))
    splitPromptRun.samples[0]!.sourceSetupPromptHash = "0".repeat(64)
    assert.throws(() => evalRunSchema.parse(splitPromptRun), /source setup prompt hash/)
    delete splitPromptRun.samples[0]!.sourceSetupPromptHash
    assert.throws(() => evalRunSchema.parse(splitPromptRun), /full source setup prompt and its hash/)
    const pluginSetupRun = structuredClone(splitPromptRun)
    pluginSetupRun.reviewer.protocol = "research-enabled-target-frozen-v5"
    delete pluginSetupRun.samples[0]!.sourceSetupPrompt
    delete pluginSetupRun.samples[0]!.sourceSetupPromptHash
    pluginSetupRun.samples[0]!.prompt =
      "<reviewbot-source-setup-v1>\nsetup command\n</reviewbot-source-setup-v1>\n\nreview prompt"
    pluginSetupRun.samples[0]!.promptHash = createHash("sha256")
      .update(pluginSetupRun.samples[0]!.prompt)
      .digest("hex")
    assert.doesNotThrow(() => evalRunSchema.parse(pluginSetupRun))
    pluginSetupRun.samples[0]!.prompt = "review prompt without setup"
    pluginSetupRun.samples[0]!.promptHash = createHash("sha256")
      .update(pluginSetupRun.samples[0]!.prompt)
      .digest("hex")
    assert.throws(() => evalRunSchema.parse(pluginSetupRun), /start with its source setup block/)
    const wrongReviewerModel = structuredClone(pinnedRun)
    wrongReviewerModel.reviewer.model = "openai/another-model"
    assert.throws(
      () => evalRunSchema.parse(wrongReviewerModel),
      /requires the pinned review mode and model/,
    )
    const wrongJudgeMode = structuredClone(pinnedRun)
    if (wrongJudgeMode.samples[0]!.status !== "completed") assert.fail("expected completed sample")
    wrongJudgeMode.samples[0]!.judgements[0]!.provenance.mode = "high"
    assert.throws(
      () => evalRunSchema.parse(wrongJudgeMode),
      /requires the pinned finding-check mode and model/,
    )
    run.samples[0]!.promptHash = "0".repeat(64)
    assert.throws(() => evalRunSchema.parse(run), /prompt hash does not match/)
    run.samples[0]!.promptHash = createHash("sha256").update(prompt).digest("hex")
    run.samples[0]!.durationMs = 11
    assert.throws(() => evalRunSchema.parse(run), /sample duration must equal/)
    run.samples[0]!.durationMs = 10
    const mutableSample = run.samples[0] as { trace: unknown[] }
    mutableSample.trace = [
      toolMessage("web_search", { objective: "Inspect lox/example PR 42" }),
    ]
    const reaudited = evalRunSchema.parse(run)
    assert.deepEqual(reaudited.samples[0]!.evidenceBoundaryViolations, [])
    assert.match(formatReport(reaudited), /1 review did not follow the review rules/)
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
      /example data hash does not match/,
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

describe("eval rescoring", () => {
  it("preserves the saved execution order", () => {
    const preparation = "Run these commands from the repository:\n\necho source\n\nUse only this source."
    const cases = [evalCase("first", control), evalCase("second", control)]
    const sourceRun = makeRun(
      cases,
      1,
      [cases[1]!, cases[0]!].map((item) => ({
        ...completed(item.id, 1, control, "success", [], []),
        sourceSetupPrompt: buildSourceSetupPrompt(preparation),
      })),
    )

    const result = rescoreRun(
      sourceRun,
      Buffer.from(JSON.stringify(sourceRun)),
      {
        corpus: { version: "pack-v1-current", cases },
        sourcePreparation: new Map(cases.map((item) => [item.id, preparation])),
      },
      "2026-09-08T12:00:00.000Z",
    )

    assert.deepEqual(result.run.samples.map((sample) => sample.caseId), ["second", "first"])
  })

  it("updates labels while dropping changed or unavailable evidence", () => {
    const oldPreparation = "Run these commands from the repository:\n\necho old-source\n\nUse only this source."
    const newPreparation = "Run these commands from the repository:\n\necho new-source\n\nUse only this source."
    const oldBlocking = structuredClone(blocking)
    oldBlocking.issues[0]!.severity = "medium"
    const ids = ["kept", "removed", "commit-changed", "context-changed", "source-changed", "issue-changed"]
    const oldCases = ids.map((id) => evalCase(id, id === "kept" || id === "issue-changed" ? oldBlocking : control))
    const sourceRun = makeRun(
      oldCases,
      1,
      oldCases.map((item) => ({
        ...completed(
          item.id,
          1,
          item.expected,
          item.id === "kept" ? "failure" : "success",
          item.id === "kept" ? [highFinding] : [],
          [],
        ),
        sourceSetupPrompt: buildSourceSetupPrompt(oldPreparation),
      })),
    )
    const currentKept = evalCase("kept", blocking)
    const currentCommit = { ...evalCase("commit-changed", control), headSha: "c".repeat(40) }
    const currentContext = evalCase("context-changed", control)
    currentContext.context.title = "Changed pull request context"
    const currentSource = evalCase("source-changed", control)
    const currentIssue = evalCase("issue-changed", oldBlocking)
    currentIssue.expected.issues[0]!.rootCause = "The recorded issue now describes another cause."
    const pack = {
      corpus: {
        version: "pack-v1-current",
        cases: [currentKept, currentCommit, currentContext, currentSource, currentIssue],
      },
      sourcePreparation: new Map([
        ["kept", oldPreparation],
        ["commit-changed", oldPreparation],
        ["context-changed", oldPreparation],
        ["source-changed", newPreparation],
        ["issue-changed", oldPreparation],
      ]),
    }
    const sourceBytes = Buffer.from(`${JSON.stringify(sourceRun)}\n`)

    const result = rescoreRun(sourceRun, sourceBytes, pack, "2026-09-08T12:00:00.000Z")

    assert.deepEqual(result.run.cases.map((item) => item.id), ["kept"])
    assert.equal(result.run.cases[0]!.expected.issues[0]!.severity, "high")
    assert.equal(result.run.samples[0]!.expected.issues[0]!.severity, "high")
    assert.equal(sourceRun.cases[0]!.expected.issues[0]!.severity, "medium")
    assert.deepEqual(result.dropped, [
      { caseId: "removed", reason: "not-in-pack" },
      { caseId: "commit-changed", reason: "review-input-changed", fields: ["commit"] },
      { caseId: "context-changed", reason: "review-input-changed", fields: ["PR context"] },
      { caseId: "source-changed", reason: "review-input-changed", fields: ["prepared source"] },
      { caseId: "issue-changed", reason: "recorded-issue-changed", issueIds: ["known-failure"] },
    ])
    assert.equal(result.run.rescoredFrom?.sourceCorpusVersion, sourceRun.corpusVersion)
    assert.equal(result.run.rescoredFrom?.packVersion, "pack-v1-current")
    assert.match(result.run.rescoredFrom?.sourceArtifactHash ?? "", /^sha256:[0-9a-f]{64}$/)
    const summary = formatRescoreSummary(result)
    assert.match(summary, /removed/)
    assert.match(summary, /commit-changed: commit/)
    assert.match(summary, /context-changed: PR context/)
    assert.match(summary, /source-changed: prepared source/)
    assert.match(summary, /issue-changed: known-failure/)
  })

  it("rejects a run when every version changed commits", () => {
    const preparation = "Run these commands from the repository:\n\necho source\n\nUse only this source."
    const oldCase = evalCase("changed", control)
    const sourceRun = makeRun(
      [oldCase],
      1,
      [{
        ...completed("changed", 1, control, "success", [], []),
        sourceSetupPrompt: buildSourceSetupPrompt(preparation),
      }],
    )
    const changedCase = { ...oldCase, headSha: "c".repeat(40) }

    assert.throws(
      () =>
        rescoreRun(
          sourceRun,
          Buffer.from(JSON.stringify(sourceRun)),
          {
            corpus: { version: "pack-v1-current", cases: [changedCase] },
            sourcePreparation: new Map([["changed", preparation]]),
          },
          "2026-09-08T12:00:00.000Z",
        ),
      /No saved versions still match/,
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
      yield judgeSystemMessage()
      yield judgeResult()
    }

    try {
      const result = await judgeIssue(
        "blocking",
        blocking.issues[0]!,
        [highFinding],
        cacheDirectory,
        testAmpVersions,
        new AbortController().signal,
        executeJudge as never,
      )
      assert.equal(options.length, 2)
      assert.ok(options.every((item) => !("project" in item)))
      assert.ok(
        options.every(
          (item) =>
            typeof item.cwd === "string" &&
            item.cwd.startsWith(join(tmpdir(), "amp-reviewbot-judge-")),
        ),
      )
      assert.ok(options.every((item) => item.mode === judgeMode))
      assert.equal(result.provenance.project, null)
      assert.equal(result.provenance.mode, judgeMode)
      assert.equal(result.provenance.model, "openai/gpt-5.6-sol")
      assert.equal(result.provenance.cliVersion, "test-cli")
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
      testAmpVersions,
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
      testAmpVersions,
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
      yield judgeSystemMessage()
      yield judgeResult()
    }

    try {
      const issue = blocking.issues[0]!
      const first = judgeIssue(
        "blocking",
        issue,
        [highFinding],
        cacheDirectory,
        testAmpVersions,
        new AbortController().signal,
        executeJudge as never,
      )
      await started.promise
      const second = judgeIssue(
        "blocking",
        issue,
        [highFinding],
        cacheDirectory,
        testAmpVersions,
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
      yield judgeSystemMessage()
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
        testAmpVersions,
        firstController.signal,
        executeJudge as never,
      )
      await firstStarted.promise
      const second = judgeIssue(
        "blocking",
        issue,
        [highFinding],
        cacheDirectory,
        testAmpVersions,
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
      yield judgeSystemMessage()
      yield judgeResult()
    }

    try {
      const result = judgeIssue(
        "blocking",
        blocking.issues[0]!,
        [highFinding],
        cacheDirectory,
        testAmpVersions,
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
      cliVersion: "test-cli",
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

function judgeSystemMessage() {
  return {
    type: "system",
    subtype: "init",
    session_id: "judge-thread",
    cwd: "/workspace",
    agent_mode: judgeMode,
    tools: [],
    mcp_servers: [],
  }
}

function traceSystemMessage(
  sessionId = "thread-1",
  cwd = "/workspace",
  agentMode = "medium",
) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    agent_mode: agentMode,
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

function toolResultMessage(toolUseId: string, isError = false, exitCode?: number) {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content:
            exitCode === undefined ? "command completed" : JSON.stringify({ output: "", exitCode }),
          is_error: isError,
        },
      ],
    },
  }
}

function turnResultMessage() {
  return {
    type: "result",
    is_error: false,
    result: "Source ready",
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
