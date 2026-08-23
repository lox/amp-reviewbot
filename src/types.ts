export type Severity = "critical" | "high" | "medium" | "low"

export type ReviewFinding = {
  severity: Severity
  title: string
  message: string
  path: string
  startLine: number
  endLine?: number
}

export type ReviewResult = {
  summary: string
  findings: ReviewFinding[]
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export type ReviewJob = {
  id: string
  sourceDeliveryId: string
  eventType: string
  installationId: string
  repositoryId: string
  repositoryFullName: string
  pullNumber: number
  baseSha: string
  headSha: string
  ampProject: string
  checkRunId: string | null
  ampThreadId: string | null
  status: JobStatus
  attempts: number
}
