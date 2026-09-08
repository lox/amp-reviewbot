import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { sourcePreparationCommand } from "../src/review.js"
import type { LoadedPack } from "./pack.js"
import {
  corpusContentHash,
  evalRunSchema,
  expectedKind,
  type EvalCase,
  type EvalRun,
  type ExpectedIssue,
} from "./schema.js"

export type RescoreDrop = NonNullable<EvalRun["rescoredFrom"]>["dropped"][number]

export type RescoreResult = {
  run: EvalRun
  dropped: RescoreDrop[]
  retained: number
  original: number
}

/** Reuses saved reviews only when everything the reviewer saw is still identical. */
export function rescoreRun(
  sourceRun: EvalRun,
  sourceBytes: Buffer,
  pack: LoadedPack,
  rescoredAt: string,
): RescoreResult {
  const currentCases = new Map(pack.corpus.cases.map((evalCase) => [evalCase.id, evalCase]))
  const samples = new Map<string, EvalRun["samples"]>()
  for (const sample of sourceRun.samples) {
    const caseSamples = samples.get(sample.caseId) ?? []
    caseSamples.push(sample)
    samples.set(sample.caseId, caseSamples)
  }

  const cases: EvalCase[] = []
  const rescoredSamples: EvalRun["samples"] = []
  const dropped: RescoreDrop[] = []
  for (const oldCase of sourceRun.cases) {
    const currentCase = currentCases.get(oldCase.id)
    if (!currentCase) {
      dropped.push({ caseId: oldCase.id, reason: "not-in-pack" })
      continue
    }
    const changedFields = reviewInputChanges(
      oldCase,
      currentCase,
      samples.get(oldCase.id) ?? [],
      pack.sourcePreparation.get(oldCase.id),
    )
    if (changedFields.length > 0) {
      dropped.push({
        caseId: oldCase.id,
        reason: "review-input-changed",
        fields: changedFields,
      })
      continue
    }
    const changedIssues = changedIssueDefinitions(oldCase, currentCase)
    if (changedIssues.length > 0) {
      dropped.push({
        caseId: oldCase.id,
        reason: "recorded-issue-changed",
        issueIds: changedIssues,
      })
      continue
    }

    cases.push(currentCase)
    const currentIssueIds = new Set(currentCase.expected.issues.map((issue) => issue.id))
    for (const sample of samples.get(oldCase.id) ?? []) {
      rescoredSamples.push(
        sample.status === "completed"
          ? {
              ...sample,
              expected: currentCase.expected,
              judgements: sample.judgements.filter((item) => currentIssueIds.has(item.issueId)),
              judgementErrors: sample.judgementErrors.filter((item) => currentIssueIds.has(item.issueId)),
            }
          : { ...sample, expected: currentCase.expected },
      )
    }
  }
  if (cases.length === 0) throw new Error("No saved versions still match the current pack")

  const corpusVersion = `${pack.corpus.version}-rescored`
  const run = evalRunSchema.parse({
    ...sourceRun,
    corpusVersion,
    corpusHash: corpusContentHash({ version: corpusVersion, cases }),
    cases,
    samples: rescoredSamples,
    ...(sourceRun.executionOrder === undefined
      ? {}
      : {
          executionOrder: sourceRun.executionOrder.filter((task) =>
            cases.some((evalCase) => evalCase.id === task.caseId),
          ),
        }),
    rescoredFrom: {
      sourceArtifactHash: artifactHash(sourceBytes),
      sourceCorpusVersion: sourceRun.corpusVersion,
      packVersion: pack.corpus.version,
      rescoredAt,
      dropped,
    },
  })
  return { run, dropped, retained: cases.length, original: sourceRun.cases.length }
}

export function formatRescoreSummary(result: RescoreResult): string {
  const lines = [`Retained versions: ${result.retained}/${result.original}`]
  const missing = result.dropped.filter((drop) => drop.reason === "not-in-pack")
  const changed = result.dropped.filter((drop) => drop.reason === "review-input-changed")
  const issues = result.dropped.filter((drop) => drop.reason === "recorded-issue-changed")
  lines.push(
    `Dropped because no longer in pack: ${missing.length === 0 ? "none" : missing.map((drop) => drop.caseId).join(", ")}`,
    "Dropped because reviewer-visible inputs changed:",
    ...(changed.length === 0
      ? ["  none"]
      : changed.map((drop) => `  ${drop.caseId}: ${drop.fields.join(", ")}`)),
    "Dropped because a recorded issue changed beyond its labels:",
    ...(issues.length === 0
      ? ["  none"]
      : issues.map((drop) => `  ${drop.caseId}: ${drop.issueIds.join(", ")}`)),
  )
  return lines.join("\n")
}

/** Identifies the two one-shot artifacts emitted by one fast A/B invocation. */
export function isAbPair(left: EvalRun, right: EvalRun): boolean {
  if (
    left.requestedSamplesPerCase !== 1 ||
    right.requestedSamplesPerCase !== 1 ||
    left.startedAt !== right.startedAt ||
    left.completedAt !== right.completedAt ||
    left.orderSeed !== right.orderSeed ||
    left.cases.length !== 16 ||
    right.cases.length !== 16
  ) {
    return false
  }
  const leftIds = left.cases.map((evalCase) => evalCase.id).sort()
  const rightIds = right.cases.map((evalCase) => evalCase.id).sort()
  if (!isDeepStrictEqual(leftIds, rightIds)) return false
  const counts = { blocking: 0, control: 0, advisory: 0 }
  for (const evalCase of left.cases) counts[expectedKind(evalCase.expected)] += 1
  return counts.blocking === 10 && counts.control === 3 && counts.advisory === 3
}

function reviewInputChanges(
  oldCase: EvalCase,
  currentCase: EvalCase,
  samples: EvalRun["samples"],
  currentPreparation: string | undefined,
): Array<"commit" | "PR context" | "prepared source"> {
  const fields = new Set<"commit" | "PR context" | "prepared source">()
  if (oldCase.baseSha !== currentCase.baseSha || oldCase.headSha !== currentCase.headSha) {
    fields.add("commit")
  }
  if (
    oldCase.repositoryFullName !== currentCase.repositoryFullName ||
    oldCase.pullNumber !== currentCase.pullNumber ||
    !isDeepStrictEqual(oldCase.context, currentCase.context)
  ) {
    fields.add("PR context")
  }
  const currentCommand =
    currentPreparation === undefined ? undefined : sourcePreparationCommand(currentPreparation)
  const savedCommands = samples.map((sample) =>
    sample.sourceSetupPrompt === undefined && sample.prompt === undefined
      ? undefined
      : sourcePreparationCommand(sample.sourceSetupPrompt ?? sample.prompt!),
  )
  if (
    !isDeepStrictEqual(oldCase.changedLines, currentCase.changedLines) ||
    currentCommand === undefined ||
    savedCommands.length === 0 ||
    savedCommands.some((command) => command !== currentCommand)
  ) {
    fields.add("prepared source")
  }
  return [...fields]
}

function changedIssueDefinitions(oldCase: EvalCase, currentCase: EvalCase): string[] {
  const oldIssues = new Map(oldCase.expected.issues.map((issue) => [issue.id, issue]))
  return currentCase.expected.issues.flatMap((issue) => {
    const oldIssue = oldIssues.get(issue.id)
    return oldIssue !== undefined && !isDeepStrictEqual(issueMeaning(oldIssue), issueMeaning(issue))
      ? [issue.id]
      : []
  })
}

function issueMeaning(issue: ExpectedIssue): Omit<ExpectedIssue, "severity" | "nature" | "category" | "subtype"> {
  const {
    severity: _severity,
    nature: _nature,
    category: _category,
    subtype: _subtype,
    ...meaning
  } = issue
  return meaning
}

function artifactHash(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}
