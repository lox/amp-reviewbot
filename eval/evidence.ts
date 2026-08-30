export function auditEvidenceBoundary(
  trace: unknown[],
  sourcePreparation: string | undefined,
): string[] {
  const violations = new Set<string>()
  for (const message of trace) {
    if (!message || typeof message !== "object" || !("message" in message)) continue
    const body = message.message
    if (!body || typeof body !== "object" || !("content" in body) || !Array.isArray(body.content)) {
      continue
    }
    for (const content of body.content) {
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
      if (!command) continue
      const segments = shellCommandSegments(command)
      if (
        segments.some(
          (segment) =>
            /\b(?:curl|wget|gh)\b|https?:\/\//i.test(segment) &&
            !isApprovedSourceCommand(segment, sourcePreparation),
        )
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
  return [...violations]
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
  return command
    .split(/\n|&&|\|\||[;|]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}
