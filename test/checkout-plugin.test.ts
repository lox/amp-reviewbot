import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { it } from "node:test"

const plugin = await import(pathToFileURL(resolve("plugins/pinned-models.js")).href)

it("prepares a shallow PR checkout, verifies exact history, and never runs checkout hooks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "reviewbot-checkout-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git(root, "init", "-b", "main", "source")
  const source = join(root, "source")
  git(source, "config", "user.email", "test@example.com")
  git(source, "config", "user.name", "Test")
  writeFileSync(join(source, "code"), "root\n")
  git(source, "add", ".")
  git(source, "commit", "-m", "root")
  const ancestor = git(source, "rev-parse", "HEAD")
  writeFileSync(join(source, "base-only"), "base\n")
  git(source, "add", ".")
  git(source, "commit", "-m", "base")
  const baseSha = git(source, "rev-parse", "HEAD")
  git(source, "checkout", "-b", "pr", ancestor)
  writeFileSync(join(source, "code"), "head\n")
  git(source, "commit", "-am", "head")
  const headSha = git(source, "rev-parse", "HEAD")
  git(source, "update-ref", "refs/pull/42/head", headSha)
  const work = join(root, "work")
  git(root, "clone", "--depth=1", "--branch=main", `file://${source}`, work)
  git(work, "remote", "set-url", "origin", "https://github.com/example/repo.git")
  git(work, "config", `url.file://${source}.insteadOf`, "https://github.com/example/repo.git")
  writeFileSync(join(work, ".git/hooks/post-checkout"), "#!/bin/sh\necho ran > hook-ran\nexit 42\n", { mode: 0o755 })
  const coordinates = { repository: "example/repo", pullNumber: 42, baseSha, headSha }
  const run = (values = coordinates) => spawnSync("bash", ["-c", plugin.checkoutCommand(values)], { cwd: work, encoding: "utf8" })
  assert.equal(git(work, "rev-parse", "--is-shallow-repository"), "true")
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(git(work, "rev-parse", "HEAD"), headSha)
  assert.equal(git(work, "merge-base", baseSha, headSha), ancestor)
  assert.equal(git(work, "rev-parse", "--is-shallow-repository"), "false")
  assert.equal(readFileSync(join(work, "code"), "utf8"), "head\n")
  assert.equal(git(work, "status", "--porcelain"), "")
  assert.equal(run().status, 0, "repeated setup is safe on the same clean revision")

  // A moved PR ref must fail instead of silently reviewing a newer head.
  git(source, "update-ref", "refs/pull/42/head", baseSha)
  assert.notEqual(run().status, 0)
  assert.equal(git(work, "rev-parse", "HEAD"), headSha)
  git(source, "update-ref", "refs/pull/42/head", headSha)
  assert.notEqual(run({ ...coordinates, baseSha: "f".repeat(40) }).status, 0)
  writeFileSync(join(work, "code"), "local change\n")
  assert.notEqual(run().status, 0)
  assert.equal(readFileSync(join(work, "code"), "utf8"), "local change\n")
  git(work, "remote", "set-url", "origin", "https://github.com/other/repo.git")
  assert.match(run().stderr, /repository mismatch/)
})

it("rejects command injection and cancels failed or malformed opt-in setup without affecting ordinary prompts", async () => {
  const coordinates = { repository: "example/repo", pullNumber: 42, baseSha: "a".repeat(40), headSha: "b".repeat(40) }
  for (const invalid of [null, {}, { ...coordinates, command: "echo bad" },
    { ...coordinates, repository: "example/repo';echo bad" }, { ...coordinates, headSha: "$(echo bad)" },
    { ...coordinates, pullNumber: "42" }, { ...coordinates, pullNumber: -1 }]) {
    assert.throws(() => plugin.checkoutCommand(invalid), /Invalid checkout coordinates/)
  }
  let handler: (event: { message: string }, context: Record<string, unknown>) => Promise<any>
  plugin.default({
    createAgent: (definition: unknown) => ({ definition }), registerAgentMode() {},
    on: (_: string, fn: typeof handler) => { handler = fn },
    system: { workspaceRoot: "workspace" }, helpers: { filePathFromURI: () => "/workspace" },
  })
  let cancelled = 0
  let calls = 0
  const timings: any[] = []
  const context = {
    thread: { cancel: async () => { cancelled++ } },
    logger: { log: (text: string) => { timings.push(JSON.parse(text)) } },
    $: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls++
      assert.equal(values[0], "/workspace")
      assert.equal(values[1], plugin.checkoutCommand(coordinates))
      return { exitCode: 0 }
    },
  }
  const message = `<reviewbot-checkout-v1>\n${JSON.stringify(coordinates)}\n</reviewbot-checkout-v1>\n\nReview.`
  const result = await handler!({ message }, context)
  assert.match(result.message.content, /Trusted checkout is ready/)
  assert.equal(timings[0].status, "ready")
  assert.equal(timings[0].headSha, coordinates.headSha)
  assert.ok(timings[0].durationMs >= 0)
  assert.equal(cancelled, 0)
  assert.equal(await handler!({ message: "Review normally." }, context), undefined)
  assert.equal(calls, 1)
  await handler!({ message: "<reviewbot-checkout-v2>bad" }, context)
  assert.equal(calls, 1)
  assert.equal(cancelled, 1)
  await handler!({ message }, { ...context, $: async () => ({ exitCode: 1 }) })
  await handler!({ message }, { ...context, $: async () => { throw new Error("offline") } })
  assert.equal(cancelled, 3)
  assert.deepEqual(timings.map(t => t.status), ["ready", "failed", "failed", "failed"])
})
