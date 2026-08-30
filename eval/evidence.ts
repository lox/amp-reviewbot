import { posix } from "node:path"

export function auditEvidenceBoundary(
  trace: unknown[],
  sourcePreparation: string | undefined,
): string[] {
  const violations = new Set<string>()
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
      if (/web|librarian|thread|github/.test(tool)) {
        violations.add(`used external-source tool ${content.name}`)
      }
      if (
        /(?:^|[^a-z])(?:task|subagent|delegate|delegation|agent|oracle)(?:$|[^a-z])/.test(
          tool,
        )
      ) {
        violations.add(`used delegated tool ${content.name} without an auditable nested trace`)
      }
      if (!("input" in content) || !content.input || typeof content.input !== "object") continue
      const input = content.input as Record<string, unknown>
      const serializedInput = JSON.stringify(input)
      if (/AGENTS\.md|SKILL\.md|\.agents\//i.test(serializedInput)) {
        violations.add("loaded repository or project instructions outside the embedded methodology")
      }
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
      if (!command) continue
      const segments = shellCommandSegments(command)
      if (
        segments.some(
          (segment) =>
            isExternalNetworkCommand(segment) &&
            !isApprovedSourceCommand(segment, sourcePreparation),
        ) || isIndirectNetworkCommand(command)
      ) {
        violations.add("ran an external network command")
      }
      const unapprovedGitNetwork = segments
        .filter((segment) => /\bgit\b.*?\b(?:clone|fetch|pull|ls-remote)\b/.test(segment))
        .some((segment) => !isApprovedSourceCommand(segment, sourcePreparation))
      if (unapprovedGitNetwork) violations.add("ran an unapproved Git network command")
      const unapprovedHistoryInspection = segments
        .filter((segment) =>
          /(?:\bgit\b.*?\b(?:branch\s+-a|for-each-ref|fsck|reflog|show-ref)\b|\bgit\b.*?\b(?:log|rev-list)\b.*?(?:--all|\bmain\b|\borigin\/)|HEAD@\{)/.test(
            segment,
          ),
        )
        .some((segment) => !isApprovedSourceCommand(segment, sourcePreparation))
      if (unapprovedHistoryInspection) {
        violations.add("inspected source outside the exact review history")
      }
    }
  }
  if (sourcePreparation !== undefined) {
    const required = sourcePreparationCommand(sourcePreparation)
    const initial = systemInit(trace[0])
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
      required === undefined ||
      !initial ||
      !firstTool ||
      !isShellTool(firstTool.tool) ||
      firstTool.command !== required ||
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

function isExternalNetworkCommand(command: string): boolean {
  const invocation = shellInvocation(command)
  if (
    (invocation && /^(?:amp|curl|wget|gh|ssh|scp|sftp)$/i.test(invocation.executable)) ||
    /https?:\/\//i.test(command)
  ) {
    return true
  }
  return isIndirectNetworkCommand(command)
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

function isApprovedSourceCommand(command: string, sourcePreparation: string | undefined): boolean {
  return (
    sourcePreparation !== undefined &&
    shellCommandSegments(sourcePreparation)
      .filter((line) => line.startsWith("git "))
      .some((approved) => command === approved)
  )
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

function isInitialWorkdir(workdir: unknown, initialCwd: string): boolean {
  return (
    workdir === undefined ||
    (typeof workdir === "string" && posix.resolve(initialCwd, workdir) === posix.normalize(initialCwd))
  )
}

function isShellTool(tool: string): boolean {
  return /bash|shell|terminal/.test(tool)
}
