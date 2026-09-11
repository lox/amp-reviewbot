import type { EvalCase, EvalRun, EvalSample } from "./schema.js"
import { scoreRun, type CaseScore, type EvalScore, type Scorecard } from "./score.js"
import { checkReviewTrace, sourcePreparationFromPrompt } from "./evidence.js"

export function formatReport(savedRun: EvalRun): string {
  // A review that broke the rules is excluded from the counts like a review
  // that never finished; the other reviews in the run remain comparable.
  const { run, excluded: traceProblems } = excludeRuleBreakingReviews(savedRun)
  const score = scoreRun(run)
  const usesCurrentRules = run.reviewer.protocol !== undefined
  const lines = [
    `Review evaluation: ${usesCurrentRules ? "PUBLIC RESEARCH ALLOWED" : "OLDER RULES"}`,
    `Recorded result: ${reportVerdict(score, traceProblems)}`,
    usesCurrentRules
      ? "The reviewer could research anything public except this pull request and another copy or later version of the target repository."
      : "This older run allowed access to the target pull request and repository history. Use its counts for investigation, not comparison.",
    `Reviewer: Amp mode ${run.reviewer.mode}. Model: ${run.reviewer.model ?? "not pinned"}. SDK: ${run.reviewer.sdkVersion}. CLI: ${run.reviewer.cliVersion ?? "not recorded"}.`,
    modelSentence(savedRun),
    "",
    `Scorecard: ${countLabel(run.cases.length, "code version")} from ${countLabel(score.seeds.length, "pull request")}, each reviewed ${run.requestedSamplesPerCase} ${run.requestedSamplesPerCase === 1 ? "time" : "times"}; ${completionSentence(score)}`,
    ...scorecardLines(score.scorecard).map((line) => `  ${line}`),
    "Right call: a version with a recorded blocking bug is blocked for that bug at blocking urgency; every other version is not blocked.",
    `${countLabel(score.seeds.length, "pull-request example")}: ${seedOutcomeSentence(score)}.`,
  ]
  if (traceProblems > 0) {
    lines.push(
      `${traceProblems} review ${traceProblems === 1 ? "did" : "runs did"} not follow the review rules and ${traceProblems === 1 ? "is" : "are"} excluded from these counts.`,
    )
  }
  if (score.uncheckedIssues > 0) {
    lines.push(
      `${countLabel(score.uncheckedIssues, "recorded issue")} could not be checked against the findings; run \`finish\` to complete the comparison.`,
    )
  }
  lines.push(...resourceLines(savedRun))

  const scores = new Map(score.cases.map((caseScore) => [caseScore.caseId, caseScore]))
  const examples = new Map<string, EvalCase[]>()
  for (const evalCase of run.cases) {
    const cases = examples.get(evalCase.seedId) ?? []
    cases.push(evalCase)
    examples.set(evalCase.seedId, cases)
  }

  const wronglyBlocked = run.cases
    .map((evalCase) => ({ evalCase, score: scores.get(evalCase.id) }))
    .filter((item) => item.score !== undefined && item.score.wronglyBlocked > 0)
    .sort((left, right) => right.score!.wronglyBlocked - left.score!.wronglyBlocked)
  if (wronglyBlocked.length > 0) {
    lines.push(
      "",
      "Wrongly blocked (check the source; a justified block means the recorded issues are incomplete):",
      ...wronglyBlocked.map(
        ({ evalCase, score }) =>
          `  #${evalCase.pullNumber} ${versionLabel(evalCase).toLowerCase()}: blocked in ${score!.wronglyBlocked} of ${score!.completed}`,
      ),
    )
  }

  let exampleNumber = 0
  const seedScores = new Map(score.seeds.map((seed) => [seed.seedId, seed]))
  for (const cases of examples.values()) {
    exampleNumber += 1
    const seed = seedScores.get(cases[0]!.seedId)!
    lines.push(
      "",
      `Example ${exampleNumber} (pull request #${cases[0]!.pullNumber}): ${seed.outcome.toUpperCase()} (right call in ${seed.passedSamples}/${seed.samples} repeats)`,
    )
    for (const evalCase of cases) {
      const caseScore = scores.get(evalCase.id)
      if (!caseScore) continue
      lines.push(`  ${caseResult(evalCase, caseScore)}`)
    }
  }

  lines.push(
    "",
    `Evidence: ${run.cases.length} code versions and ${run.samples.length} review runs.`,
    "This result covers only these examples; it is not a general quality claim.",
  )
  return lines.join("\n")
}

export function scorecardLines(card: Scorecard): string[] {
  const { badPrs, okPrs, cleanPrs, advisoryIssues } = card
  return [
    `Bad PRs blocked:        ${fraction(badPrs.blocked, badPrs.reviews)} across ${countLabel(badPrs.versions, "version")} with a recorded blocking bug; ${badPrs.versionsRightEveryTime} blocked every time.${badPrs.reviews === 0 ? "" : ` Of the rest: ${badPrs.blockedForOtherReason} blocked for something else, ${badPrs.foundAtLowerUrgency} found the bug at lower urgency, ${badPrs.missed} missed it.`}`,
    `OK PRs wrongly blocked: ${fraction(okPrs.wronglyBlocked, okPrs.reviews)} across ${countLabel(okPrs.versions, "version")} without one; ${okPrs.versionsRightEveryTime} never blocked.`,
    `Clean PRs left alone:   ${fraction(cleanPrs.quiet, cleanPrs.reviews)} across ${countLabel(cleanPrs.versions, "version")} with no recorded issues.`,
    `Recorded advisory issues found: ${fraction(advisoryIssues.found, advisoryIssues.chances)}.`,
  ]
}

export function fraction(count: number, total: number): string {
  if (total === 0) return "none to count"
  return `${count} of ${total} (${Math.round((count / total) * 100)}%)`
}

function modelSentence(run: EvalRun): string {
  const models = new Set<string>()
  for (const sample of run.samples) {
    for (const model of sample.models) models.add(model)
    if (sample.status === "completed") {
      for (const judgement of sample.judgements) {
        for (const model of judgement.models) models.add(model)
      }
    }
  }
  return models.size === 0
    ? "Exact model IDs: not reported by Amp."
    : `Reported model IDs: ${[...models].sort().join(", ")}.`
}

export interface ReviewResources {
  reviews: number
  totalReviewMs: number
  medianReviewMs: number
  longestReviewMs: number
  /** Reviews in which Amp had to be run again, and how many extra runs that took. */
  retried: { reviews: number; runs: number }
  /** What Amp billed, from `amp threads usage`; absent when no review recorded it. */
  billed?: {
    reviews: number
    costUsd: number
    medianCostUsd: number
    inputTokens: number
    outputTokens: number
    requests: number
    subscriptionUsed: boolean
  }
  /** Reviews whose usage lookup ran but returned no numbers, grouped by the reason recorded. */
  usageUnavailable?: { reviews: number; reasons: string[] }
  /** Tokens summed from the assistant turns in the saved traces (no subagent turns, no cost). */
  traced?: {
    reviews: number
    inputTokens: number
    outputTokens: number
    medianInputTokens: number
  }
}

/**
 * Time, cost, and tokens spent by the reviewer across every saved review,
 * including reviews later excluded from the counts, which still cost money.
 */
export function reviewResources(run: EvalRun): ReviewResources | undefined {
  const durations = run.samples.flatMap((sample) => sample.reviewDurationMs ?? [])
  if (durations.length === 0) return undefined
  const usages = run.samples.flatMap((sample) => sample.usage ?? [])
  const unavailable = run.samples.flatMap((sample) => sample.usageUnavailable ?? [])
  // An empty trace means Amp never started, so there is no usage to count.
  const traced = run.samples.flatMap((sample) =>
    sample.trace === undefined || sample.trace.length === 0 ? [] : [sumTraceUsage(sample.trace)],
  )
  const retries = run.samples.flatMap((sample) => sample.retries ?? [])
  return {
    reviews: durations.length,
    totalReviewMs: durations.reduce((sum, ms) => sum + ms, 0),
    medianReviewMs: median(durations),
    longestReviewMs: Math.max(...durations),
    retried: {
      reviews: retries.filter((count) => count > 0).length,
      runs: retries.reduce((sum, count) => sum + count, 0),
    },
    ...(usages.length === 0
      ? {}
      : {
          billed: {
            reviews: usages.length,
            costUsd: usages.reduce((sum, usage) => sum + usage.costUsd, 0),
            medianCostUsd: median(usages.map((usage) => usage.costUsd)),
            inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
            outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
            requests: usages.reduce((sum, usage) => sum + usage.requests, 0),
            subscriptionUsed: usages.some((usage) => usage.subscriptionUsed),
          },
        }),
    ...(unavailable.length === 0
      ? {}
      : { usageUnavailable: { reviews: unavailable.length, reasons: [...new Set(unavailable)].sort() } }),
    ...(traced.length === 0
      ? {}
      : {
          traced: {
            reviews: traced.length,
            inputTokens: traced.reduce((sum, usage) => sum + usage.input, 0),
            outputTokens: traced.reduce((sum, usage) => sum + usage.output, 0),
            medianInputTokens: median(traced.map((usage) => usage.input)),
          },
        }),
  }
}

function resourceLines(run: EvalRun): string[] {
  const resources = reviewResources(run)
  if (resources === undefined) return []
  const lines = [
    `Review time: ${countLabel(resources.reviews, "review")} took ${hours(resources.totalReviewMs)} in total; median ${minutes(resources.medianReviewMs)}, longest ${minutes(resources.longestReviewMs)}.`,
  ]
  const { retried, billed, traced, usageUnavailable } = resources
  if (retried.reviews > 0) {
    lines.push(
      `Amp had to be run again in ${countLabel(retried.reviews, "review")} (${countLabel(retried.runs, "extra run")}); the time above includes those runs.`,
    )
  }
  if (billed !== undefined) {
    const coverage = billed.reviews === resources.reviews ? "" : ` (${billed.reviews} of ${resources.reviews} reviews reported usage)`
    lines.push(
      `Amp usage${coverage}: $${billed.costUsd.toFixed(2)} in credits, ${millions(billed.inputTokens)} input tokens, ${millions(billed.outputTokens)} output tokens, ${countLabel(billed.requests, "model request")}; median $${billed.medianCostUsd.toFixed(2)} per review. Subagent threads are included.${billed.subscriptionUsed ? " A subscription covered some inference, so credits understate the cost." : ""}`,
    )
  } else if (traced !== undefined) {
    const why =
      usageUnavailable === undefined
        ? "This run recorded no Amp usage"
        : `Amp reported no usage for ${countLabel(usageUnavailable.reviews, "review thread")} (${reasonList(usageUnavailable.reasons)})`
    lines.push(
      `Reviewer tokens from ${countLabel(traced.reviews, "trace")}: ${millions(traced.inputTokens)} input tokens (including cache reads and writes), ${millions(traced.outputTokens)} output tokens; median ${millions(traced.medianInputTokens)} input tokens per review. ${why}, so cost is unknown and tokens spent by delegated subagents are not counted.`,
    )
  }
  if (billed !== undefined && usageUnavailable !== undefined) {
    lines.push(
      `Amp reported no usage for ${countLabel(usageUnavailable.reviews, "review thread")} (${reasonList(usageUnavailable.reasons)}); their cost is not in the total.`,
    )
  }
  return lines
}

/** The first few distinct reasons; a run with many different failures should not flood the summary. */
function reasonList(reasons: string[]): string {
  const shown = reasons.slice(0, 3)
  const more = reasons.length - shown.length
  return more > 0 ? `${shown.join("; ")}; and ${countLabel(more, "other reason")}` : shown.join("; ")
}

function sumTraceUsage(trace: unknown[]): { input: number; output: number } {
  const usage = { input: 0, output: 0 }
  for (const message of trace) {
    if (!message || typeof message !== "object" || !("message" in message)) continue
    const body = message.message
    if (!body || typeof body !== "object" || !("usage" in body)) continue
    const counts = body.usage
    if (!counts || typeof counts !== "object") continue
    usage.input +=
      tokenCount(counts, "input_tokens") +
      tokenCount(counts, "cache_creation_input_tokens") +
      tokenCount(counts, "cache_read_input_tokens")
    usage.output += tokenCount(counts, "output_tokens")
  }
  return usage
}

function tokenCount(usage: object, key: string): number {
  const value = (usage as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`
}

function hours(ms: number): string {
  return ms < 3_600_000 ? minutes(ms) : `${(ms / 3_600_000).toFixed(1)} hours`
}

function millions(tokens: number): string {
  return tokens < 1_000_000 ? `${Math.round(tokens / 1_000)}k` : `${(tokens / 1_000_000).toFixed(1)}M`
}

function seedOutcomeSentence(score: EvalScore): string {
  const counts = { pass: 0, unstable: 0, fail: 0 }
  for (const seed of score.seeds) counts[seed.outcome] += 1
  return `${counts.pass} pass, ${counts.unstable} unstable, ${counts.fail} fail`
}

export function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`
}

function completionSentence(score: EvalScore): string {
  return score.completedReviews === score.reviews
    ? `all ${score.reviews} reviews completed.`
    : `${score.completedReviews} of ${score.reviews} reviews completed.`
}

export function versionLabel(evalCase: EvalCase): string {
  return evalCase.versionRole === "baseline"
    ? "Baseline"
    : evalCase.versionRole === "introduced-issue"
      ? "Introduced-issue version"
      : "Version"
}

function caseResult(evalCase: EvalCase, score: CaseScore): string {
  const role = versionLabel(evalCase)
  const label =
    score.kind === "control"
      ? "no recorded issues"
      : score.kind === "advisory"
        ? "recorded non-blocking issues"
        : "recorded blocking bug"
  if (score.completed === 0) return `${role}, ${label}: no reviews completed`

  const parts: string[] = []
  if (score.kind === "blocking") {
    parts.push(`blocked for it in ${score.blockedForRecordedBug} of ${score.completed}`)
    if (score.blockedForOtherReason > 0) parts.push(`blocked for something else in ${score.blockedForOtherReason}`)
    if (score.foundAtLowerUrgency > 0) parts.push(`found it at lower urgency in ${score.foundAtLowerUrgency}`)
    if (score.missed > 0) parts.push(`missed it in ${score.missed}`)
  } else if (score.kind === "advisory") {
    parts.push(`not blocked in ${score.completed - score.wronglyBlocked} of ${score.completed}`)
    if (score.wronglyBlocked > 0) parts.push(`wrongly blocked in ${score.wronglyBlocked}`)
  } else {
    parts.push(`left alone in ${score.quiet} of ${score.completed}`)
    const flagged = score.completed - score.quiet - score.wronglyBlocked
    if (flagged > 0) parts.push(`raised a non-blocking finding in ${flagged}`)
    if (score.wronglyBlocked > 0) parts.push(`wrongly blocked in ${score.wronglyBlocked}`)
  }
  if (score.advisoryChances > 0) {
    parts.push(`${score.advisoryFound} of ${score.advisoryChances} recorded advisory issues found`)
  }
  if (score.unmatchedFindings > 0) {
    parts.push(
      `${score.unmatchedFindings} unmatched ${score.unmatchedFindings === 1 ? "finding needs" : "findings need"} source checking`,
    )
  }
  if (score.droppedFindings > 0) {
    parts.push(
      `${score.droppedFindings} raw ${score.droppedFindings === 1 ? "finding" : "findings"} dropped for not pointing at a changed line`,
    )
  }
  if (score.uncheckedIssues > 0) {
    parts.push(`${countLabel(score.uncheckedIssues, "recorded issue")} not yet checked`)
  }
  return `${role}, ${label}: ${parts.join("; ")}`
}

function reportVerdict(score: EvalScore, traceProblems: number): string {
  if (score.seeds.length === 0) return "INCOMPLETE"
  if (traceProblems > 0 || score.completedReviews < score.reviews || score.uncheckedIssues > 0) {
    return "INCOMPLETE"
  }
  if (score.seeds.some((seed) => seed.outcome === "fail")) return "NEEDS WORK"
  if (score.seeds.some((seed) => seed.outcome === "unstable")) return "UNSTABLE"
  return "PASSED THESE EXAMPLES"
}

export function excludeRuleBreakingReviews(run: EvalRun): { run: EvalRun; excluded: number } {
  const cases = new Map(run.cases.map((evalCase) => [evalCase.id, evalCase]))
  let excluded = 0
  const samples = run.samples.map((sample): EvalSample => {
    const evalCase = cases.get(sample.caseId)!
    // The stored trace is the evidence; the saved violation list is only a cache
    // of an earlier check and is used when the trace was not kept.
    const problems =
      sample.trace === undefined || sample.prompt === undefined
        ? (sample.evidenceBoundaryViolations ?? [])
        : checkReviewTrace(
            sample.trace,
            sourcePreparationFromPrompt(sample.sourceSetupPrompt ?? sample.prompt),
            {
              repository: evalCase.repositoryFullName,
              pullNumber: evalCase.pullNumber,
              baseSha: evalCase.baseSha,
              headSha: evalCase.headSha,
            },
            run.reviewer.protocol?.startsWith("research-enabled-target-frozen")
              ? run.reviewer.mode
              : undefined,
            run.reviewer.protocol === "research-enabled-target-frozen-v4"
              ? "separate-turn"
              : run.reviewer.protocol === "research-enabled-target-frozen-v5"
                ? "plugin"
                : undefined,
          )
    if (problems.length === 0) return sample
    excluded += 1
    if (sample.status === "error") return sample
    const {
      rawResult: _rawResult,
      parsedResult: _parsedResult,
      retainedResult: _retainedResult,
      omitted: _omitted,
      conclusion: _conclusion,
      severityRepass: _severityRepass,
      judgements: _judgements,
      judgementErrors: _judgementErrors,
      ...common
    } = sample
    return {
      ...common,
      status: "error",
      error: `did not follow the review rules: ${problems.join("; ")}`,
    }
  })
  return { run: { ...run, samples }, excluded }
}
