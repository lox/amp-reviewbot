import { posix } from "node:path"

export type EvidenceTarget = {
  repository: string
  pullNumber: number
  baseSha: string
  headSha: string
}

export function auditEvidenceBoundary(
  trace: unknown[],
  sourcePreparation: string | undefined,
  target?: EvidenceTarget,
): string[] {
  const violations = new Set<string>()
  const requiredPreparation =
    sourcePreparation === undefined ? undefined : sourcePreparationCommand(sourcePreparation)
  const initial = systemInit(trace[0])
  const toolUses: Array<{
    id: string
    tool: string
    command?: string
    workdir?: unknown
  }> = []
  const toolEvents: Array<
    | { type: "use"; id: string }
    | { type: "result"; id: string; succeeded: boolean }
  > = []
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
        toolEvents.push({
          type: "result",
          id: content.tool_use_id,
          succeeded: "is_error" in content && content.is_error === false,
        })
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
        toolEvents.push({ type: "use", id: content.id })
        toolUses.push({
          id: content.id,
          tool,
          ...(command === undefined ? {} : { command }),
          ...(input.workdir === undefined && input.cwd === undefined
            ? {}
            : { workdir: input.workdir ?? input.cwd }),
        })
      }
      if (!target || (requiredPreparation !== undefined && command === requiredPreparation)) continue
      const canAccessExternalEvidence =
        isExternalSourceTool(tool) || (command !== undefined && isExternalNetworkCommand(command))
      if (canAccessExternalEvidence && refersToTargetPullRequest(serializedInput, target)) {
        violations.add("accessed the target pull request")
      } else if (canAccessExternalEvidence && refersToTargetRepository(serializedInput, target)) {
        violations.add("accessed the target repository outside the supplied snapshot")
      } else if (
        command !== undefined &&
        accessesPreparedRepositoryNetwork(command) &&
        isInitialWorkdir(input.workdir ?? input.cwd, initial?.cwd)
      ) {
        violations.add("accessed the target repository outside the supplied snapshot")
      }
    }
  }
  if (sourcePreparation !== undefined) {
    const systems = trace.flatMap((message) => {
      const system = systemInit(message)
      return system ? [system] : []
    })
    if (!initial) violations.add("did not start in an isolated review workspace")
    if (
      initial &&
      systems.some(
        ({ sessionId, cwd }) => sessionId !== initial.sessionId || cwd !== initial.cwd,
      )
    ) {
      violations.add("review continuation changed the isolated workspace")
    }
    const firstTool = toolUses[0]
    const firstUseIndex = firstTool
      ? toolEvents.findIndex(({ type, id }) => type === "use" && id === firstTool.id)
      : -1
    const firstResultIndex = firstTool
      ? toolEvents.findIndex(({ type, id }) => type === "result" && id === firstTool.id)
      : -1
    const firstResult = toolEvents[firstResultIndex]
    const startedAnotherTool = toolEvents
      .slice(firstUseIndex + 1, firstResultIndex < 0 ? undefined : firstResultIndex)
      .some(({ type }) => type === "use")
    if (
      requiredPreparation === undefined ||
      !initial ||
      !firstTool ||
      !isShellTool(firstTool.tool) ||
      firstTool.command !== requiredPreparation ||
      !isInitialWorkdir(firstTool.workdir, initial.cwd) ||
      firstResultIndex <= firstUseIndex ||
      firstResult?.type !== "result" ||
      !firstResult.succeeded ||
      startedAnotherTool
    ) {
      violations.add("did not complete the trusted source preparation")
    }
  }
  return [...violations]
}

function isExternalSourceTool(tool: string): boolean {
  return /web|librarian|thread|github|oracle|task|subagent|delegate|agent/.test(tool)
}

function refersToTargetPullRequest(value: string, target: EvidenceTarget): boolean {
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
    ...value.matchAll(/--repo(?:sitory)?(?:=|\s+)([a-z0-9_.-]+\/[a-z0-9_.-]+)/gi),
    ...value.matchAll(/"repository"\s*:\s*"([a-z0-9_.-]+\/[a-z0-9_.-]+)"/gi),
  ].flatMap((match) => (match[1] ? [match[1].toLowerCase()] : []))
  return repositories.length > 0 && repositories.every((name) => name !== targetRepository)
}

function refersToTargetRepository(value: string, target: EvidenceTarget): boolean {
  const normalized = value.toLowerCase()
  return (
    normalized.includes(target.repository.toLowerCase()) ||
    normalized.includes(target.baseSha.toLowerCase()) ||
    normalized.includes(target.headSha.toLowerCase())
  )
}

function isExternalNetworkCommand(command: string): boolean {
  const invocation = shellInvocation(command)
  if (
    (invocation && /^(?:amp|curl|wget|gh|ssh|scp|sftp)$/i.test(invocation.executable)) ||
    (invocation &&
      /^git$/i.test(invocation.executable) &&
      /\b(?:clone|fetch|pull|ls-remote)\b/i.test(invocation.args)) ||
    /https?:\/\//i.test(command)
  ) {
    return true
  }
  return isIndirectNetworkCommand(command)
}

function accessesPreparedRepositoryNetwork(command: string): boolean {
  return shellCommandSegments(command).some((segment) =>
    /\bgit\b.*?\b(?:fetch|pull)\b/i.test(segment),
  )
}

function isIndirectNetworkCommand(command: string): boolean {
  const invocation = shellInvocation(command)
  if (!invocation) return false
  if (
    /^(?:npx|bunx)$/i.test(invocation.executable) ||
    (/^(?:npm|pnpm|yarn|bun)$/i.test(invocation.executable) &&
      /^\s+(?:add|audit|ci|dlx|exec|fund|i|info|install|outdated|pack|ping|publish|search|update|view)\b/i.test(
        invocation.args,
      ))
  ) {
    return true
  }
  return (
    /^(?:node|python\d*|ruby)$/i.test(invocation.executable) &&
    /\b(?:fetch|http\.client|https?|net\.connect|open-uri|requests|socket|urllib)\b/i.test(command)
  )
}

function shellInvocation(command: string): { executable: string; args: string } | undefined {
  const match = /^(?:(?:then|do|else|command|exec|nohup)\s+|(?:env|sudo)(?:\s+-\S+)*\s+|[a-z_][a-z0-9_]*=\S+\s+)*(?:\S*\/)?([a-z0-9_.+-]+)([\s\S]*)$/i.exec(
    command.trim(),
  )
  return match?.[1] && match[2] !== undefined
    ? { executable: match[1], args: match[2] }
    : undefined
}

export function sourcePreparationFromPrompt(prompt: string): string | undefined {
  return /<source-preparation>\n([\s\S]*?)\n<\/source-preparation>/.exec(prompt)?.[1]
}

function shellCommandSegments(command: string): string[] {
  const segments: string[] = []
  let start = 0
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    const width =
      character === "\n" || character === ";" || character === "|"
        ? command[index + 1] === character
          ? 2
          : 1
        : character === "&" && command[index + 1] === "&"
          ? 2
          : 0
    if (width === 0) continue
    segments.push(command.slice(start, index).trim())
    index += width - 1
    start = index + 1
  }
  segments.push(command.slice(start).trim())
  return segments.filter(Boolean)
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
