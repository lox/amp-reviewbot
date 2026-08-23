import { App } from "octokit"
import type { Config } from "./config.js"
import type { ReviewJob, ReviewResult, Severity } from "./types.js"
import { checkConclusion } from "./review.js"

const annotationLevel: Record<Severity, "failure" | "warning" | "notice"> = {
  critical: "failure",
  high: "failure",
  medium: "warning",
  low: "notice",
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
    const findings = result.findings.filter((finding) =>
      changedLines.get(finding.path)?.has(finding.startLine),
    )
    const omitted = result.findings.length - findings.length
    const summary = [
      result.summary,
      omitted > 0 ? `\n\n_${omitted} finding(s) omitted because they did not reference a changed line._` : "",
      job.ampThreadId ? `\n\n[Open the Amp review thread](https://ampcode.com/threads/${job.ampThreadId})` : "",
    ].join("")

    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: Number(checkRunId),
      status: "completed",
      completed_at: new Date().toISOString(),
      conclusion: checkConclusion(result, this.config.failOn),
      ...(job.ampThreadId
        ? { details_url: `https://ampcode.com/threads/${job.ampThreadId}` }
        : {}),
      output: {
        title: checkTitle(result.findings.length),
        summary,
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
            title: `[${finding.severity}] ${finding.title}`.slice(0, 255),
            message: finding.message,
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
      output: { title, summary: message.slice(0, 60_000) },
    })
  }
}

function splitRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo, extra] = fullName.split("/")
  if (!owner || !repo || extra) throw new Error(`Invalid repository name: ${fullName}`)
  return { owner, repo }
}

function checkTitle(findings: number): string {
  if (findings === 0) return "No actionable issues found"
  return `Amp found ${findings} actionable ${findings === 1 ? "issue" : "issues"}`
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
