import { posix } from "node:path"

type ReviewTarget = {
  repository: string
  pullNumber: number
  baseSha: string
  headSha: string
}

export function checkReviewTrace(
  trace: unknown[],
  sourcePreparation: string | undefined,
  target?: ReviewTarget,
): string[] {
  const problems = new Set<string>()
  const requiredPreparation =
    sourcePreparation === undefined ? undefined : sourcePreparationCommand(sourcePreparation)
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
  let startedAnotherToolBeforeFirstFinished = false
  for (const message of trace) {
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
        if (content.tool_use_id === firstTool?.id) {
          firstToolFinished = true
          firstToolSucceeded = "is_error" in content && content.is_error === false
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
      }
      if (!target || (requiredPreparation !== undefined && command === requiredPreparation)) continue
      const canAccessExternalEvidence =
        isResearchTool(tool) || (command !== undefined && runsNetworkCommand(command))
      if (canAccessExternalEvidence && refersToTargetPullRequest(serializedInput, target)) {
        problems.add("accessed the target pull request")
      } else if (canAccessExternalEvidence && refersToTargetRepository(serializedInput, target)) {
        problems.add("accessed the target repository outside the supplied copy")
      } else if (
        command !== undefined &&
        updatesPreparedRepository(command) &&
        isInitialWorkdir(input.workdir ?? input.cwd, initial?.cwd)
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
      requiredPreparation === undefined ||
      !initial ||
      !firstTool ||
      !isShellTool(firstTool.tool) ||
      firstTool.command !== requiredPreparation ||
      !isInitialWorkdir(firstTool.workdir, initial.cwd) ||
      !firstToolFinished ||
      !firstToolSucceeded ||
      startedAnotherToolBeforeFirstFinished
    ) {
      problems.add("did not complete the required source setup")
    }
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

function updatesPreparedRepository(command: string): boolean {
  return /(?:^|[\n;&|])\s*(?:(?:command|env|exec|sudo)\s+)*(?:\S*\/)?git\b[^\n;&|]*\b(?:fetch|pull)\b/im.test(
    command,
  )
}

export function sourcePreparationFromPrompt(prompt: string): string | undefined {
  return /<source-preparation>\n([\s\S]*?)\n<\/source-preparation>/.exec(prompt)?.[1]
}

function sourcePreparationCommand(sourcePreparation: string): string | undefined {
  return /Run these commands from the repository:\n\n([\s\S]*?)\n\nUse only/.exec(
    sourcePreparation,
  )?.[1]
}

function systemInit(message: unknown): { sessionId: string; cwd: string } | undefined {
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
  return { sessionId: message.session_id, cwd: message.cwd }
}

function isInitialWorkdir(workdir: unknown, initialCwd: string | undefined): boolean {
  return (
    initialCwd !== undefined &&
    (workdir === undefined ||
      (typeof workdir === "string" &&
        posix.resolve(initialCwd, workdir) === posix.normalize(initialCwd)))
  )
}

function isShellTool(tool: string): boolean {
  return /bash|shell|terminal/.test(tool)
}
