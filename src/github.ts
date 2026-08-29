import { App } from "octokit"
import type { Config } from "./config.js"
import type { ReviewFinding, ReviewJob, ReviewResult, Severity } from "./types.js"
import { finalizeReview, isBlockingSeverity } from "./review.js"

const annotationLevel: Record<Severity, "failure" | "warning" | "notice"> = {
  critical: "failure",
  high: "failure",
  medium: "warning",
  low: "notice",
}

const severityLabel: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
}

export class GitHubClient {
  private readonly app: App

  constructor(private readonly config: Config) {
    this.app = new App({
      appId: config.githubAppId,
      privateKey: config.githubPrivateKey,
    })
  }

  async createCheck(job: ReviewJob): Promise<string> {
    const { owner, repo } = splitRepository(job.repositoryFullName)
    const octokit = await this.app.getInstallationOctokit(Number(job.installationId))
    const response = await octokit.rest.checks.create({
      owner,
      repo,
      name: "Amp Review",
      head_sha: job.headSha,
      status: "queued",
      external_id: job.id,
    })
    return String(response.data.id)
  }

  async startCheck(job: ReviewJob, checkRunId: string): Promise<void> {
    const { owner, repo } = splitRepository(job.repositoryFullName)
    const octokit = await this.app.getInstallationOctokit(Number(job.installationId))
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: Number(checkRunId),
      status: "in_progress",
      started_at: new Date().toISOString(),
    })
  }

  async linkCheck(job: ReviewJob, checkRunId: string, ampThreadId: string): Promise<void> {
    const { owner, repo } = splitRepository(job.repositoryFullName)
    const octokit = await this.app.getInstallationOctokit(Number(job.installationId))
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: Number(checkRunId),
      details_url: `https://ampcode.com/threads/${ampThreadId}`,
    })
  }

  async currentHead(job: ReviewJob): Promise<string> {
    const { owner, repo } = splitRepository(job.repositoryFullName)
    const octokit = await this.app.getInstallationOctokit(Number(job.installationId))
    const response = await octokit.rest.pulls.get({ owner, repo, pull_number: job.pullNumber })
    return response.data.head.sha
  }

  async changedLines(job: ReviewJob): Promise<Map<string, Set<number>>> {
    const { owner, repo } = splitRepository(job.repositoryFullName)
    const octokit = await this.app.getInstallationOctokit(Number(job.installationId))
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: job.pullNumber,
      per_page: 100,
    })
    return new Map(
      files.map((file) => [file.filename, file.patch ? parseChangedLines(file.patch) : new Set<number>()]),
    )
  }

  async completeCheck(
    job: ReviewJob,
    checkRunId: string,
    result: ReviewResult,
    changedLines: Map<string, Set<number>>,
  ): Promise<void> {
    const { owner, repo } = splitRepository(job.repositoryFullName)
    const octokit = await this.app.getInstallationOctokit(Number(job.installationId))
    const finalized = finalizeReview(result, changedLines, this.config.failOn)
    const findings = finalized.result.findings
    const blocking = findings.filter((finding) =>
      isBlockingSeverity(finding.severity, this.config.failOn),
    ).length
    const title = checkTitle(blocking, findings.length - blocking)
    const summary = [
      finalized.omitted === 0 ? result.summary : "",
      finalized.omitted > 0
        ? `\n\n_${finalized.omitted} finding(s) omitted because they did not reference a changed line._`
        : "",
    ]
      .join("")
      .trim()

    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: Number(checkRunId),
      status: "completed",
      completed_at: new Date().toISOString(),
      conclusion: finalized.conclusion,
      ...(job.ampThreadId
        ? { details_url: `https://ampcode.com/threads/${job.ampThreadId}` }
        : {}),
      output: {
        title,
        summary,
        ...(findings.length > 0 ? { text: checkText(findings) } : {}),
        annotations: findings.map((finding) => {
          const lines = changedLines.get(finding.path)!
          const requestedEnd = Math.max(finding.startLine, finding.endLine ?? finding.startLine)
          const endLine = allLinesChanged(lines, finding.startLine, requestedEnd)
            ? requestedEnd
            : finding.startLine
          return {
            path: finding.path,
            start_line: finding.startLine,
            end_line: endLine,
            annotation_level: annotationLevel[finding.severity],
            title: `${severityLabel[finding.severity]} · ${finding.title}`.slice(0, 255),
            message: `${finding.message}\n\nSuggested fix: ${finding.suggestion}`,
          }
        }),
      },
    })
  }

  async cancelCheck(job: ReviewJob, checkRunId: string, reason: string): Promise<void> {
    await this.finishWithMessage(job, checkRunId, "cancelled", "Review cancelled", reason)
  }

  async failCheck(job: ReviewJob, checkRunId: string, reason: string): Promise<void> {
    await this.finishWithMessage(job, checkRunId, "failure", "Review failed", reason)
  }

  private async finishWithMessage(
    job: ReviewJob,
    checkRunId: string,
    conclusion: "cancelled" | "failure",
    title: string,
    message: string,
  ): Promise<void> {
    const { owner, repo } = splitRepository(job.repositoryFullName)
    const octokit = await this.app.getInstallationOctokit(Number(job.installationId))
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: Number(checkRunId),
      status: "completed",
      completed_at: new Date().toISOString(),
      conclusion,
      ...(job.ampThreadId
        ? { details_url: `https://ampcode.com/threads/${job.ampThreadId}` }
        : {}),
      output: { title, summary: message.slice(0, 60_000) },
    })
  }
}

function splitRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo, extra] = fullName.split("/")
  if (!owner || !repo || extra) throw new Error(`Invalid repository name: ${fullName}`)
  return { owner, repo }
}

export function checkTitle(
  blocking: number,
  advisory: number,
): string {
  if (blocking === 0 && advisory === 0) return "No issues found"
  const parts = [issueCount(blocking, "blocking"), issueCount(advisory, "advisory")].filter(
    (part) => part !== null,
  )
  return parts.join(", ")
}

function issueCount(count: number, kind: "blocking" | "advisory"): string | null {
  if (count === 0) return null
  return `${count} ${kind} ${count === 1 ? "issue" : "issues"}`
}

function checkText(findings: ReviewFinding[]): string {
  const text = findings
    .map(
      (finding) =>
        `### ${severityLabel[finding.severity]} · ${finding.title}\n\n${finding.message}\n\n**Suggested fix:** ${finding.suggestion}\n\n\`${finding.path}:${finding.startLine}\``,
    )
    .join("\n\n---\n\n")
  return text.length <= 60_000 ? text : `${text.slice(0, 59_970)}\n\n_Report truncated._`
}

export function parseChangedLines(patch: string): Set<number> {
  const changed = new Set<number>()
  let newLine = 0
  let inHunk = false

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      newLine = Number(hunk[1])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith("\\")) continue
    if (line.startsWith("+")) {
      changed.add(newLine)
      newLine += 1
    } else if (!line.startsWith("-")) {
      newLine += 1
    }
  }

  return changed
}

function allLinesChanged(lines: Set<number>, start: number, end: number): boolean {
  for (let line = start; line <= end; line += 1) {
    if (!lines.has(line)) return false
  }
  return true
}
