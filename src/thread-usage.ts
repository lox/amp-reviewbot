import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type ThreadUsage = {
  costUsd: number
  estimatedProviderCostAtListPriceUsd?: number
  inputTokens: number
  outputTokens: number
  requests: number
  subscriptionUsed: boolean
}

export type ThreadUsageLookup = { usage: ThreadUsage } | { unavailable: string }

export async function readThreadUsage(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ThreadUsageLookup> {
  try {
    const { stdout } = await execFileAsync(
      resolve("node_modules", ".bin", "amp"),
      ["threads", "usage", "--details", threadId],
      { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    )
    const usage = parseThreadUsage(stdout)
    return usage === null ? { unavailable: usageUnavailableReason(stdout) } : { usage }
  } catch (error) {
    return { unavailable: `amp threads usage failed: ${execFailureReason(error)}` }
  }
}

export function usageUnavailableReason(report: string): string {
  const explanation = report
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /usage information/i.test(line))
  return explanation ?? "amp threads usage printed no cost or token counts"
}

export function execFailureReason(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown error"
  const { stderr, killed, code } = error as { stderr?: unknown; killed?: unknown; code?: unknown }
  const stderrLine =
    typeof stderr === "string" ? stderr.split("\n").find((line) => line.trim() !== "")?.trim() : undefined
  if (stderrLine) return stderrLine
  if (killed === true) return "timed out"
  if (code !== undefined && code !== null) return `exited with ${String(code)}`
  return "unknown error"
}

export function parseThreadUsage(report: string): ThreadUsage | null {
  const costUsd = numberAfter(report, /^Cost: \$([\d,]+(?:\.\d+)?)$/m)
  const inputTokens = numberAfter(report, /^Input tokens: ([\d,]+)/m)
  const outputTokens = numberAfter(report, /^Output tokens: ([\d,]+)/m)
  const requests = numberAfter(report, /^Requests: ([\d,]+)$/m)
  if (costUsd === undefined || inputTokens === undefined || outputTokens === undefined || requests === undefined) {
    return null
  }
  return {
    costUsd,
    ...estimatedListPrice(report),
    inputTokens,
    outputTokens,
    requests,
    subscriptionUsed: /subscription was used for some inference/.test(report),
  }
}

function estimatedListPrice(report: string): Pick<ThreadUsage, "estimatedProviderCostAtListPriceUsd"> {
  if (/^Est\. list price: N\/A$/m.test(report)) return {}
  const summary = numberAfter(report, /^Est\. list price: \$([\d,]+(?:\.\d+)?)$/m)
  if (summary !== undefined) return { estimatedProviderCostAtListPriceUsd: summary }

  const lines = report.split("\n")
  const headerIndex = lines.findIndex((line) => tableCells(line).includes("Est. list price"))
  if (headerIndex < 0) return {}
  const estimateColumn = tableCells(lines[headerIndex]!).indexOf("Est. list price")
  const estimates: number[] = []
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) break
    const value = /^\$([\d,]+(?:\.\d+)?)$/.exec(tableCells(line)[estimateColumn] ?? "")?.[1]
    if (value === undefined) return {}
    estimates.push(Number(value.replaceAll(",", "")))
  }
  return estimates.length === 0
    ? {}
    : { estimatedProviderCostAtListPriceUsd: estimates.reduce((sum, value) => sum + value, 0) }
}

function tableCells(line: string): string[] {
  if (!line.trim().startsWith("|")) return []
  return line.split("|").slice(1, -1).map((cell) => cell.trim())
}

function numberAfter(report: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(report)
  return match === null ? undefined : Number(match[1]!.replaceAll(",", ""))
}
