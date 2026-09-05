import { posix } from "node:path"
import { agentModeFromMessage } from "../src/amp.js"
import {
  preparedSourceVerificationCommand,
  sourcePreparationCommand,
} from "../src/review.js"

export type ReviewTarget = {
  repository: string
  pullNumber: number
  baseSha: string
  headSha: string
}

export function modelsFromTrace(trace: unknown[]): string[] {
  const models = new Set<string>()
  for (const message of trace) {
    const model = modelFromMessage(message)
    if (model !== undefined) models.add(model)
  }
  return [...models]
}

export function modelFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("message" in message)) return undefined
  const body = message.message
  if (!body || typeof body !== "object" || !("model" in body)) return undefined
  return typeof body.model === "string" ? body.model : undefined
}

export function checkReviewTrace(
  trace: unknown[],
  sourcePreparation: string | undefined,
  target?: ReviewTarget,
  expectedMode?: string,
  sourceSetup?: "separate-turn" | "plugin",
): string[] {
  // An empty trace means Amp never started; the sample is already an error and
  // there is no reviewer behaviour to judge.
  if (trace.length === 0) return []
  const problems = new Set<string>()
  const requiredPreparation =
    sourcePreparation === undefined ? undefined : sourcePreparationCommand(sourcePreparation)
  const requiredFirstCommand =
    sourceSetup === "plugin" && target
      ? preparedSourceVerificationCommand(target)
      : requiredPreparation
  const initial = systemInit(trace[0])
  let firstTool:
    | {
        id: string
        tool: string
        command?: string
        workdir?: unknown
      }
    | undefined
  let firstToolFinished = false
  let firstToolSucceeded = false
  let firstToolExitCode: number | undefined
  let startedAnotherToolBeforeFirstFinished = false
  let setupTurnFinished = false
  let setupTurnToolCount = 0
  for (const message of trace) {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "result" &&
      "is_error" in message &&
      message.is_error === false
    ) {
      setupTurnFinished = true
    }
    if (!message || typeof message !== "object" || !("message" in message)) continue
    const body = message.message
    if (!body || typeof body !== "object" || !("content" in body) || !Array.isArray(body.content)) {
      continue
    }
    for (const content of body.content) {
      if (
        content &&
        typeof content === "object" &&
        "type" in content &&
        content.type === "tool_result" &&
        "tool_use_id" in content &&
        typeof content.tool_use_id === "string"
      ) {
        if (firstTool && content.tool_use_id === firstTool.id) {
          firstToolFinished = true
          firstToolExitCode = shellExitCode(content.content)
          firstToolSucceeded =
            content.is_error === false &&
            (firstToolExitCode === undefined || firstToolExitCode === 0)
        }
        continue
      }
      if (
        !content ||
        typeof content !== "object" ||
        !("type" in content) ||
        content.type !== "tool_use" ||
        !("name" in content) ||
        typeof content.name !== "string"
      ) {
        continue
      }
      const tool = content.name.toLowerCase()
      if (!setupTurnFinished) setupTurnToolCount += 1
      if (!("input" in content) || !content.input || typeof content.input !== "object") continue
      const input = content.input as Record<string, unknown>
      const serializedInput = JSON.stringify(input)
      const command =
        typeof input.command === "string"
          ? input.command
          : typeof input.cmd === "string"
            ? input.cmd
            : undefined
      if ("id" in content && typeof content.id === "string") {
        if (firstTool && !firstToolFinished) startedAnotherToolBeforeFirstFinished = true
        firstTool ??= {
          id: content.id,
          tool,
          ...(command === undefined ? {} : { command }),
          ...(input.workdir === undefined && input.cwd === undefined
              ? {}
              : { workdir: input.workdir ?? input.cwd }),
        }
        // Scratch experiments in another directory (a throwaway Go module, a
        // downloaded toolchain) are research. Moving Git work or the target
        // repository out of the prepared workspace is not.
        if (
          content.id !== firstTool.id &&
          isShellTool(tool) &&
          usesDifferentWorkdir(input.workdir ?? input.cwd, firstTool.workdir) &&
          (command === undefined ||
            /(?:^|[\s;&|(])(?:\S*\/)?git\b/.test(command) ||
            (target !== undefined && refersToTargetRepository(serializedInput, target)))
        ) {
          problems.add("review continued in a different workspace")
        }
      }
      if (
        !target ||
        (sourceSetup !== "plugin" &&
          requiredPreparation !== undefined &&
          command === requiredPreparation)
      ) {
        continue
      }
      // A research request that explicitly tells the subagent to stay away from
      // the target ("do not inspect example/repository or PR #42") is the reviewer
      // following the rules, not breaking them.
      const canAccessExternalEvidence =
        (isResearchTool(tool) && !explicitlyExcludesTarget(serializedInput, target)) ||
        (command !== undefined && runsNetworkCommand(command))
      if (canAccessExternalEvidence && refersToTargetPullRequest(serializedInput, target)) {
        problems.add("accessed the target pull request")
      } else if (canAccessExternalEvidence && refersToTargetRepository(serializedInput, target)) {
        problems.add("accessed the target repository outside the supplied copy")
      } else if (
        command !== undefined &&
        updatesPreparedRepository(command, input.workdir ?? input.cwd, firstTool?.workdir)
      ) {
        problems.add("accessed the target repository outside the supplied copy")
      }
    }
  }
  if (sourcePreparation !== undefined) {
    const systems = trace.flatMap((message) => {
      const system = systemInit(message)
      return system ? [system] : []
    })
    if (!initial) problems.add("did not start in a clean review workspace")
    if (
      initial &&
      systems.some(
        ({ sessionId, cwd }) => sessionId !== initial.sessionId || cwd !== initial.cwd,
      )
    ) {
      problems.add("review continued in a different workspace")
    }
    if (
      requiredFirstCommand === undefined ||
      !initial ||
      !firstTool ||
      !isShellTool(firstTool.tool) ||
      firstTool.command !== requiredFirstCommand ||
      !isAbsoluteWorkdir(firstTool.workdir) ||
      !firstToolFinished ||
      !firstToolSucceeded ||
      startedAnotherToolBeforeFirstFinished ||
      (sourceSetup !== undefined && firstToolExitCode !== 0) ||
      (sourceSetup === "separate-turn" &&
        (!setupTurnFinished || setupTurnToolCount !== 1))
    ) {
      problems.add("did not complete the required source setup")
    }
  }
  if (expectedMode !== undefined && initial?.agentMode !== expectedMode) {
    problems.add("did not use the required agent mode")
  }
  return [...problems]
}

function isResearchTool(tool: string): boolean {
  return /web|librarian|thread|github|oracle|task|subagent|delegate|agent/.test(tool)
}

function refersToTargetPullRequest(value: string, target: ReviewTarget): boolean {
  const normalized = value.toLowerCase()
  const repository = target.repository.toLowerCase()
  const pull = target.pullNumber.toString()
  return (
    normalized.includes(`github.com/${repository}/pull/${pull}`) ||
    normalized.includes(`${repository}#${pull}`) ||
    (!namesDifferentRepository(value, repository) &&
      new RegExp(`(?:pull(?:\\s+request)?|pr)\\s*#?${pull}(?:\\D|$)`, "i").test(value))
  )
}

function namesDifferentRepository(value: string, targetRepository: string): boolean {
  const repositories = [
    ...value.matchAll(/github\.com[/:]([a-z0-9_.-]+\/[a-z0-9_.-]+)/gi),
    ...value.matchAll(/(?:--repo(?:sitory)?|-R)(?:=|\s+)([a-z0-9_.-]+\/[a-z0-9_.-]+)/gi),
    ...value.matchAll(/"repository"\s*:\s*"([a-z0-9_.-]+\/[a-z0-9_.-]+)"/gi),
    ...value.matchAll(
      /([a-z0-9_.-]+\/[a-z0-9_.-]+)\s+(?:pull(?:\s+request)?|pr)\s*#?\d+/gi,
    ),
  ].flatMap((match) => (match[1] ? [match[1].toLowerCase()] : []))
  return repositories.length > 0 && repositories.every((name) => name !== targetRepository)
}

function refersToTargetRepository(value: string, target: ReviewTarget): boolean {
  const normalized = value.toLowerCase()
  return (
    normalized.includes(target.repository.toLowerCase()) ||
    normalized.includes(target.baseSha.toLowerCase()) ||
    normalized.includes(target.headSha.toLowerCase())
  )
}

function explicitlyExcludesTarget(value: string, target: ReviewTarget): boolean {
  const pull = target.pullNumber.toString()
  // A clause runs from the negation to the end of the sentence. Inputs are
  // JSON-serialized, so an escaped newline also ends the clause.
  const clauses = value.matchAll(
    /\b(?:do not|don't|never|not|without|other than|except(?:ing)?|excluding|rather than|instead of|outside(?: of)?|avoid(?:ing)?)\b((?:(?![.;](?:\s|$)|\\n)[^\n])*)/gi,
  )
  for (const [, clause = ""] of clauses) {
    if (
      refersToTargetRepository(clause, target) ||
      new RegExp(`(?:pull(?:\\s+request)?|pr)\\s*#?${pull}(?:\\D|$)`, "i").test(clause)
    ) {
      return true
    }
  }
  return false
}

function runsNetworkCommand(command: string): boolean {
  return (
    /https?:\/\//i.test(command) ||
    /(?:^|[\n;&|])\s*(?:(?:command|env|exec|sudo)\s+)*(?:\S*\/)?(?:amp|curl|gh|scp|sftp|ssh|wget)\b/im.test(
      command,
    ) ||
    /(?:^|[\n;&|])\s*(?:(?:command|env|exec|sudo)\s+)*(?:\S*\/)?git\b[^\n;&|]*\b(?:clone|fetch|ls-remote|pull)\b/im.test(
      command,
    )
  )
}

function updatesPreparedRepository(
  command: string,
  workdir: unknown,
  preparedWorkdir: unknown,
): boolean {
  // Quoted text such as search patterns must not look like a git command, but
  // a quoted -C/--git-dir/--work-tree value still needs to be read back.
  const quoted: string[] = []
  const masked = command.replace(/"[^"\n]*"|'[^'\n]*'/g, (match) => {
    quoted.push(match.slice(1, -1))
    return `\u0000${quoted.length - 1}\u0000`
  })
  for (const segment of masked.split(/[\n;&|]/)) {
    const git = /^\s*(?:(?:command|env|exec|sudo)\s+)*(?:\S*\/)?git\b(.*)$/i.exec(segment)
    if (!git || !/\b(?:fetch|pull)\b/.test(git[1] ?? "")) continue
    // `git fetch -h` and `git help fetch` read documentation, not the remote.
    if (
      /(?:^|\s)(?:-h|--help)(?:\s|$)|^\s+(?:-[cC]\s+\S+\s+|-\S+\s+)*help\b/.test(git[1] ?? "")
    ) {
      continue
    }
    const repository = /\s(?:-C|--git-dir|--work-tree)(?:=|\s+)(\S+)/.exec(git[1] ?? "")
    if (!repository) {
      if (usesPreparedWorkdir(workdir, preparedWorkdir)) return true
      continue
    }
    // A git invocation aimed at another repository is only exempt when that
    // repository is demonstrably outside the prepared copy. A shell-expanded
    // path (mktemp scratch directories) cannot be resolved and is trusted.
    const path = (repository[1] ?? "").replace(
      /\u0000(\d+)\u0000/g,
      (_, index: string) => quoted[Number(index)] ?? "",
    )
    if (/[$`~]/.test(path) || typeof preparedWorkdir !== "string") continue
    const base = typeof workdir === "string" ? posix.resolve(preparedWorkdir, workdir) : preparedWorkdir
    if (usesPreparedWorkdir(posix.resolve(base, path), preparedWorkdir)) return true
  }
  return false
}

export function sourcePreparationFromPrompt(prompt: string): string | undefined {
  return (
    /<source-preparation>\n([\s\S]*?)\n<\/source-preparation>/.exec(prompt)?.[1] ??
    /<reviewbot-source-setup-v1>\n[\s\S]*?\n<\/reviewbot-source-setup-v1>/.exec(prompt)?.[0]
  )
}

function systemInit(
  message: unknown,
): { sessionId: string; cwd: string; agentMode?: string } | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "system" ||
    !("subtype" in message) ||
    message.subtype !== "init" ||
    !("session_id" in message) ||
    typeof message.session_id !== "string" ||
    !("cwd" in message) ||
    typeof message.cwd !== "string"
  ) {
    return undefined
  }
  const agentMode = agentModeFromMessage(message)
  return {
    sessionId: message.session_id,
    cwd: message.cwd,
    ...(agentMode === undefined ? {} : { agentMode }),
  }
}

function usesPreparedWorkdir(workdir: unknown, preparedWorkdir: unknown): boolean {
  if (workdir === undefined || preparedWorkdir === undefined) return true
  if (typeof workdir !== "string" || typeof preparedWorkdir !== "string") return false
  const relative = posix.relative(
    posix.normalize(preparedWorkdir),
    posix.resolve(preparedWorkdir, workdir),
  )
  return relative === "" || (!relative.startsWith("../") && relative !== "..")
}

function isAbsoluteWorkdir(workdir: unknown): workdir is string {
  return typeof workdir === "string" && posix.isAbsolute(workdir)
}

function usesDifferentWorkdir(workdir: unknown, preparedWorkdir: unknown): boolean {
  return workdir !== undefined && !usesPreparedWorkdir(workdir, preparedWorkdir)
}

function isShellTool(tool: string): boolean {
  return /bash|shell|terminal/.test(tool)
}

function shellExitCode(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || !("exitCode" in parsed)) return undefined
    return typeof parsed.exitCode === "number" ? parsed.exitCode : undefined
  } catch {
    return undefined
  }
}
