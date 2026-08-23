import { z } from "zod"
import type { Severity } from "./types.js"

const severitySchema = z.enum(["critical", "high", "medium", "low"])

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(16),
  AMP_API_KEY: z.string().min(1),
  AMP_PROJECTS: z.string().default("{}"),
  AMP_THREAD_VISIBILITY: z.enum(["private", "workspace"]).default("private"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  REVIEW_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  FAIL_ON: severitySchema.default("high"),
  LOG_LEVEL: z.string().default("info"),
})

export type Config = {
  port: number
  databaseUrl: string
  databaseSsl: boolean
  githubAppId: number
  githubPrivateKey: string
  githubWebhookSecret: string
  ampProjects: Record<string, string>
  ampThreadVisibility: "private" | "workspace"
  workerConcurrency: number
  reviewTimeoutMs: number
  failOn: Severity
  logLevel: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env)
  const projectValue: unknown = JSON.parse(parsed.AMP_PROJECTS)
  const configuredProjects = z.record(z.string(), z.string().min(1)).parse(projectValue)
  const ampProjects = Object.fromEntries(
    Object.entries(configuredProjects).map(([repository, project]) => [repository.toLowerCase(), project]),
  )

  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    databaseSsl: parsed.DATABASE_SSL === "true",
    githubAppId: parsed.GITHUB_APP_ID,
    githubPrivateKey: parsed.GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n"),
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    ampProjects,
    ampThreadVisibility: parsed.AMP_THREAD_VISIBILITY,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    reviewTimeoutMs: parsed.REVIEW_TIMEOUT_MINUTES * 60_000,
    failOn: parsed.FAIL_ON,
    logLevel: parsed.LOG_LEVEL,
  }
}

export function resolveAmpProject(config: Config, repositoryFullName: string): string {
  return config.ampProjects[repositoryFullName.toLowerCase()] ?? repositoryFullName
}
