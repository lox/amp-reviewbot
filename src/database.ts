import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Pool, type PoolClient } from "pg"
import type { Config } from "./config.js"
import type { JobStatus, ReviewJob } from "./types.js"

type JobRow = {
  id: string
  source_delivery_id: string
  event_type: string
  installation_id: string
  repository_id: string
  repository_full_name: string
  pull_number: number
  base_sha: string
  head_sha: string
  amp_project: string
  check_run_id: string | null
  amp_thread_id: string | null
  status: JobStatus
  attempts: number
}

export type NewReviewJob = Omit<
  ReviewJob,
  "id" | "checkRunId" | "ampThreadId" | "status" | "attempts"
> & {
  checkRunId?: string
}

export type StaleJobRecovery = {
  requeued: number
  exhausted: ReviewJob[]
}

function mapJob(row: JobRow): ReviewJob {
  return {
    id: row.id,
    sourceDeliveryId: row.source_delivery_id,
    eventType: row.event_type,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    pullNumber: row.pull_number,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    ampProject: row.amp_project,
    checkRunId: row.check_run_id,
    ampThreadId: row.amp_thread_id,
    status: row.status,
    attempts: row.attempts,
  }
}

export class Database {
  readonly pool: Pool

  constructor(config: Config) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      ...(config.databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
      max: Math.max(5, config.workerConcurrency + 2),
    })
  }

  async migrate(): Promise<void> {
    const sql = await readFile(resolve("migrations/001_initial.sql"), "utf8")
    await this.pool.query(sql)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async healthcheck(): Promise<void> {
    await this.pool.query("SELECT 1")
  }

  async enqueue(input: NewReviewJob): Promise<ReviewJob | null> {
    const result = await this.pool.query<JobRow>(
      `INSERT INTO review_jobs (
         source_delivery_id, event_type, installation_id, repository_id,
         repository_full_name, pull_number, base_sha, head_sha, amp_project, check_run_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source_delivery_id) DO NOTHING
       RETURNING *`,
      [
        input.sourceDeliveryId,
        input.eventType,
        input.installationId,
        input.repositoryId,
        input.repositoryFullName,
        input.pullNumber,
        input.baseSha,
        input.headSha,
        input.ampProject,
        input.checkRunId ?? null,
      ],
    )
    const row = result.rows[0]
    if (!row) return null

    await this.pool.query(
      `UPDATE review_jobs
       SET status = 'cancelled', completed_at = NOW(), updated_at = NOW(),
           error = 'Superseded by a newer pull request revision'
       WHERE repository_id = $1 AND pull_number = $2 AND head_sha <> $3
         AND status IN ('queued', 'running')`,
      [input.repositoryId, input.pullNumber, input.headSha],
    )

    return mapJob(row)
  }

  async enqueueRerun(
    sourceJobId: string,
    deliveryId: string,
    checkRunId: string,
  ): Promise<ReviewJob | null> {
    const result = await this.pool.query<JobRow>(
      `INSERT INTO review_jobs (
         source_delivery_id, event_type, installation_id, repository_id,
         repository_full_name, pull_number, base_sha, head_sha, amp_project, check_run_id
       )
       SELECT $2, 'check_run.rerequested', installation_id, repository_id,
              repository_full_name, pull_number, base_sha, head_sha, amp_project, $3
       FROM review_jobs WHERE id = $1
       ON CONFLICT (source_delivery_id) DO NOTHING
       RETURNING *`,
      [sourceJobId, deliveryId, checkRunId],
    )
    const row = result.rows[0]
    return row ? mapJob(row) : null
  }

  async cancelPull(repositoryId: string, pullNumber: number, reason: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE review_jobs
       SET status = 'cancelled', completed_at = NOW(), updated_at = NOW(), error = $3
       WHERE repository_id = $1 AND pull_number = $2
         AND status IN ('queued', 'running')`,
      [repositoryId, pullNumber, reason],
    )
    return result.rowCount ?? 0
  }

  async claim(): Promise<ReviewJob | null> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query<JobRow>(
        `SELECT * FROM review_jobs
         WHERE status = 'queued'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      )
      const row = result.rows[0]
      if (!row) {
        await client.query("COMMIT")
        return null
      }
      const updated = await client.query<JobRow>(
        `UPDATE review_jobs
         SET status = 'running', attempts = attempts + 1, started_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [row.id],
      )
      await client.query("COMMIT")
      return mapJob(updated.rows[0]!)
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async recoverStaleJobs(reviewTimeoutMs: number, maxAttempts: number): Promise<StaleJobRecovery> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query<JobRow>(
        `SELECT * FROM review_jobs
         WHERE status = 'running'
           AND updated_at < NOW() - ($1::text || ' milliseconds')::interval
         FOR UPDATE SKIP LOCKED`,
        [reviewTimeoutMs + 5 * 60_000],
      )
      const recoverable = result.rows.filter((row) => row.attempts < maxAttempts)
      if (recoverable.length > 0) {
        await client.query(
          `UPDATE review_jobs
           SET status = 'queued', started_at = NULL, updated_at = NOW(),
               error = 'Recovered after worker interruption'
           WHERE id = ANY($1::bigint[])`,
          [recoverable.map((row) => row.id)],
        )
      }
      await client.query("COMMIT")
      return {
        requeued: recoverable.length,
        exhausted: result.rows
          .filter((row) => row.attempts >= maxAttempts)
          .map(mapJob),
      }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async setCheckRun(jobId: string, checkRunId: string): Promise<void> {
    await this.pool.query(
      "UPDATE review_jobs SET check_run_id = $2, updated_at = NOW() WHERE id = $1",
      [jobId, checkRunId],
    )
  }

  async setThread(jobId: string, threadId: string): Promise<void> {
    await this.pool.query(
      "UPDATE review_jobs SET amp_thread_id = $2, updated_at = NOW() WHERE id = $1",
      [jobId, threadId],
    )
  }

  async status(jobId: string): Promise<JobStatus | null> {
    const result = await this.pool.query<{ status: JobStatus }>(
      "SELECT status FROM review_jobs WHERE id = $1",
      [jobId],
    )
    return result.rows[0]?.status ?? null
  }

  async requeue(jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE review_jobs
       SET status = 'queued', started_at = NULL, updated_at = NOW(),
           error = 'Requeued during service shutdown'
       WHERE id = $1 AND status = 'running'`,
      [jobId],
    )
  }

  async finish(jobId: string, status: Extract<JobStatus, "succeeded" | "failed" | "cancelled">, error?: string): Promise<void> {
    await this.pool.query(
      `UPDATE review_jobs
       SET status = $2, error = $3, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [jobId, status, error ?? null],
    )
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK")
  } catch {
    // The original transaction error is more useful.
  }
}
